package cloud.treenewbee.quizforge.hub.account;

import java.io.ByteArrayOutputStream;
import java.net.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.Flow;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;
import static cloud.treenewbee.quizforge.hub.account.AccountCrypto.*;

@Component
public class DefaultVerificationProvider implements VerificationProvider {
    public record Signed(URI uri,Map<String,String> headers,String body) {}
    private final AuthSettings settings;
    private final Clock clock;
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final JsonMapper json=JsonMapper.builder().build();
    public DefaultVerificationProvider(AuthSettings settings,Clock clock) { this.settings=settings;this.clock=clock; }
    @Override public boolean available(String channel) {
        if(channel.equals("email")) return settings.enabled("TENCENT_SES_ENABLED") && !settings.value("TENCENT_SECRET_ID").isEmpty() && !settings.value("TENCENT_SECRET_KEY").isEmpty() && !settings.value("TENCENT_SES_FROM").isEmpty()
            && Set.of("ap-hongkong","ap-guangzhou").contains(settings.value("TENCENT_SES_REGION","ap-hongkong")) && validTemplate() && pepper(channel).length()>=32;
        return channel.equals("phone") && settings.enabled("ALIYUN_SMS_ENABLED") && List.of("ALIYUN_SMS_ACCESS_KEY_ID","ALIYUN_SMS_ACCESS_KEY_SECRET","ALIYUN_SMS_SIGN_NAME","ALIYUN_SMS_TEMPLATE_CODE").stream().allMatch(key -> !settings.value(key).isEmpty()) && pepper(channel).length()>=32;
    }
    private boolean validTemplate() { try { return Long.parseLong(settings.value("TENCENT_SES_TEMPLATE_ID"))>0; } catch(NumberFormatException e) { return false; } }
    @Override public String pepper(String channel) { return settings.value(channel.equals("email")?"EMAIL_CODE_PEPPER":"SMS_CODE_PEPPER"); }
    private boolean productionKey(String value) { return !value.isEmpty()&&!value.matches("^(?:1x|2x|3x).*" ); }
    @Override public boolean captchaReady() { return productionKey(settings.value("TURNSTILE_SITE_KEY")) && productionKey(settings.value("TURNSTILE_SECRET_KEY")); }
    @Override public String siteKey() { return captchaReady()?settings.value("TURNSTILE_SITE_KEY"):""; }
    public static LinkedHashMap<String,Object> object(Object... pairs) { var result=new LinkedHashMap<String,Object>();for(int i=0;i<pairs.length;i+=2)result.put((String)pairs[i],pairs[i+1]);return result; }
    @Override public boolean verify(String token,String ip,String hostname,String action) {
        if(!captchaReady()||token==null||token.isEmpty()||token.length()>2048) return false;
        try {
            var response=post(new Signed(URI.create("https://challenges.cloudflare.com/turnstile/v0/siteverify"),Map.of("Content-Type","application/json"),json.writeValueAsString(object("secret",settings.value("TURNSTILE_SECRET_KEY"),"response",token,"remoteip",ip))));
            return Boolean.TRUE.equals(response.get("success"))&&hostname.equals(response.get("hostname"))&&action.equals(response.get("action"));
        } catch(RuntimeException error) { return false; }
    }
    public Signed emailRequest(String email,String code,String purpose,long timestamp) {
        String subject=purpose.startsWith("login:")?"QuizForge 登录验证码":purpose.startsWith("bind:")?"QuizForge 绑定验证码":"QuizForge 注册验证码";
        String body=json.writeValueAsString(object("FromEmailAddress","QuizForge <"+settings.value("TENCENT_SES_FROM")+">","Destination",List.of(email),"Subject",subject,"Template",object("TemplateID",Long.parseLong(settings.value("TENCENT_SES_TEMPLATE_ID")),"TemplateData",json.writeValueAsString(object("code",code))),"TriggerType",1));
        return emailSigned(body,timestamp);
    }
    private Signed emailSigned(String body,long timestamp){
        String host="ses.tencentcloudapi.com",date=Instant.ofEpochSecond(timestamp).toString().substring(0,10);
        String signed="content-type;host;x-tc-action",canonical="POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:"+host+"\nx-tc-action:sendemail\n\n"+signed+"\n"+sha(body),scope=date+"/ses/tc3_request";
        byte[] key=hmac(hmac(hmac(utf8("TC3"+settings.value("TENCENT_SECRET_KEY")),date),"ses"),"tc3_request");
        String authorization="TC3-HMAC-SHA256 Credential="+settings.value("TENCENT_SECRET_ID")+"/"+scope+", SignedHeaders="+signed+", Signature="+hex(hmac(key,"TC3-HMAC-SHA256\n"+timestamp+"\n"+scope+"\n"+sha(canonical)));
        return new Signed(URI.create("https://"+host+"/"),Map.of("Content-Type","application/json; charset=utf-8","Authorization",authorization,"X-TC-Action","SendEmail","X-TC-Version","2020-10-02","X-TC-Region",settings.value("TENCENT_SES_REGION","ap-hongkong"),"X-TC-Timestamp",String.valueOf(timestamp)),body);
    }
    @Override public boolean reviewReady(){try{return settings.enabled("TENCENT_SES_ENABLED")&&!settings.value("TENCENT_SECRET_ID").isEmpty()&&!settings.value("TENCENT_SECRET_KEY").isEmpty()&&!settings.value("TENCENT_SES_FROM").isEmpty()&&Set.of("ap-hongkong","ap-guangzhou").contains(settings.value("TENCENT_SES_REGION","ap-hongkong"))&&Long.parseLong(settings.value("TENCENT_SES_REVIEW_TEMPLATE_ID"))>0;}catch(NumberFormatException error){return false;}}
    @Override public void sendReview(String email){if(!reviewReady())throw new IllegalStateException("ReviewMailDisabled");String body=json.writeValueAsString(object("FromEmailAddress","QuizForge <"+settings.value("TENCENT_SES_FROM")+">","Destination",List.of(email),"Subject","QuizForge 有题库等待审核","Template",object("TemplateID",Long.parseLong(settings.value("TENCENT_SES_REVIEW_TEMPLATE_ID")),"TemplateData","{}"),"TriggerType",1));var result=post(emailSigned(body,clock.instant().getEpochSecond()));var response=(Map<?,?>)result.get("Response");if(response==null||response.get("Error")!=null||response.get("MessageId")==null)throw new IllegalStateException("ReviewMailRejected");}
    public static String encode(String value) { return URLEncoder.encode(value,java.nio.charset.StandardCharsets.UTF_8).replace("+","%20").replace("*","%2A").replace("%7E","~"); }
    public Signed smsRequest(String phone,String code,String outId,Instant date,String nonce) {
        var params=new TreeMap<String,String>();
        params.put("PhoneNumber",phone.substring(3));params.put("CountryCode","86");params.put("SignName",settings.value("ALIYUN_SMS_SIGN_NAME"));params.put("TemplateCode",settings.value("ALIYUN_SMS_TEMPLATE_CODE"));params.put("TemplateParam",json.writeValueAsString(object("code",code,"min","10")));
        params.put("OutId",outId);params.put("ValidTime","600");params.put("Interval","60");params.put("ReturnVerifyCode","false");params.put("AutoRetry","0");
        String query=params.entrySet().stream().map(entry -> encode(entry.getKey())+"="+encode(entry.getValue())).collect(java.util.stream.Collectors.joining("&"));
        var headers=new TreeMap<String,String>();headers.put("host","dypnsapi.aliyuncs.com");headers.put("x-acs-action","SendSmsVerifyCode");headers.put("x-acs-version","2017-05-25");headers.put("x-acs-date",date.truncatedTo(ChronoUnit.SECONDS).toString());headers.put("x-acs-signature-nonce",nonce);headers.put("x-acs-content-sha256",sha(""));
        String signed=String.join(";",headers.keySet()),canonical="POST\n/\n"+query+"\n"+headers.entrySet().stream().map(entry -> entry.getKey()+":"+entry.getValue().strip()+"\n").collect(java.util.stream.Collectors.joining())+"\n"+signed+"\n"+sha("");
        String authorization="ACS3-HMAC-SHA256 Credential="+settings.value("ALIYUN_SMS_ACCESS_KEY_ID")+",SignedHeaders="+signed+",Signature="+hmac(settings.value("ALIYUN_SMS_ACCESS_KEY_SECRET"),"ACS3-HMAC-SHA256\n"+sha(canonical));
        headers.remove("host"); headers.put("Accept","application/json");headers.put("Authorization",authorization);
        return new Signed(URI.create("https://dypnsapi.aliyuncs.com/?"+query),headers,"");
    }
    @Override public void send(Contact contact,String code,String nonce,String purpose) {
        if(!available(contact.channel())) throw new IllegalStateException("VerificationProviderDisabled");
        Map<String,Object> result=post(contact.channel().equals("email")?emailRequest(contact.value(),code,purpose,clock.instant().getEpochSecond()):smsRequest(contact.value(),code,nonce,clock.instant(),UUID.randomUUID().toString()));
        if(contact.channel().equals("email")) {
            if(!(result.get("Response") instanceof Map<?,?> response) || response.containsKey("Error") || !(response.get("MessageId") instanceof String)) throw new IllegalStateException("MailProviderRejected");
        } else if(!"OK".equals(result.get("Code")) || !Boolean.TRUE.equals(result.get("Success"))) throw new IllegalStateException("SmsProviderRejected");
    }
    @SuppressWarnings("unchecked") private Map<String,Object> post(Signed request) {
        var builder=HttpRequest.newBuilder(request.uri()).timeout(Duration.ofSeconds(10)).POST(HttpRequest.BodyPublishers.ofString(request.body()));request.headers().forEach(builder::header);
        var future=client.sendAsync(builder.build(),ignored -> new LimitedBody());
        try { var response=future.get(10,TimeUnit.SECONDS);if(response.statusCode()<200||response.statusCode()>=300)throw new IllegalStateException("VerificationProviderRejected"); Object value=json.readValue(response.body(),Object.class);if(!(value instanceof Map<?,?>))throw new IllegalStateException("InvalidVerificationResponse");return (Map<String,Object>)value; }
        catch(Exception error) { future.cancel(true);if(error instanceof InterruptedException)Thread.currentThread().interrupt();throw new IllegalStateException("VerificationProviderUnavailable"); }
    }
    private static class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result=new CompletableFuture<>(); private final ByteArrayOutputStream bytes=new ByteArrayOutputStream();private Flow.Subscription subscription;
        public CompletionStage<byte[]> getBody(){return result;}
        public void onSubscribe(Flow.Subscription value){subscription=value;value.request(1);}
        public void onNext(List<ByteBuffer> chunks){for(var chunk:chunks){if(chunk.remaining()>65536-bytes.size()){subscription.cancel();result.completeExceptionally(new IllegalStateException("VerificationResponseTooLarge"));return;}byte[] data=new byte[chunk.remaining()];chunk.get(data);bytes.writeBytes(data);}subscription.request(1);}
        public void onError(Throwable error){result.completeExceptionally(error);}public void onComplete(){result.complete(bytes.toByteArray());}
    }
}
