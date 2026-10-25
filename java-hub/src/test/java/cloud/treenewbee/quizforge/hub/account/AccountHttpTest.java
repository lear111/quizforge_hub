package cloud.treenewbee.quizforge.hub.account;

import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.*;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.*;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={"ADMIN_ENABLED=true","HUB_DEVICE_CONNECT_ENABLED=true","hub.trust-proxy=true","logging.level.root=WARN"})
@Import(AccountHttpTest.Fakes.class)
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class AccountHttpTest {
    static final Path DIRECTORY;
    static {try{DIRECTORY=Files.createTempDirectory("qfh-java-account-http-");}catch(Exception e){throw new ExceptionInInitializerError(e);}}
    static final String PASSWORD="synthetic-account-password";
    static final AtomicInteger IPS=new AtomicInteger();
    static final JsonMapper JSON=JsonMapper.builder().build();
    @DynamicPropertySource static void data(DynamicPropertyRegistry registry){registry.add("hub.data-dir",DIRECTORY::toString);}
    static class MutableClock extends Clock {volatile long now=System.currentTimeMillis();public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId zone){return this;}public Instant instant(){return Instant.ofEpochMilli(now);}public long millis(){return now;}}
    static class Provider implements VerificationProvider {
        final Map<String,String> sent=new ConcurrentHashMap<>();final List<String> actions=new CopyOnWriteArrayList<>();boolean failure,email=true,phone=true;
        public boolean available(String channel){return channel.equals("email")?email:phone;}public String pepper(String channel){return "synthetic-"+channel+"-pepper-".repeat(5);}public boolean captchaReady(){return true;}public String siteKey(){return "synthetic-public-site-key";}
        public boolean verify(String token,String ip,String hostname,String action){actions.add(action);return "valid".equals(token)&&hostname.equals("127.0.0.1");}
        public void send(Contact contact,String code,String nonce,String purpose){if(failure)throw new IllegalStateException("synthetic failure");sent.put(contact.value(),code);}
    }
    static class TestCrypto extends AccountCrypto {Runnable afterHash;@Override public String password(String plain){String result=super.password(plain);Runnable action=afterHash;afterHash=null;if(action!=null)action.run();return result;}}
    @TestConfiguration static class Fakes {@Bean @Primary MutableClock testClock(){return new MutableClock();}@Bean @Primary Provider testProvider(){return new Provider();}@Bean @Primary TestCrypto testCrypto(){return new TestCrypto();}}
    @Autowired HubDatabase db;@Autowired TestCrypto crypto;@Autowired MutableClock clock;@Autowired Provider provider;@Value("${local.server.port}") int port;
    final HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();String ip,owner,admin,ownerCookie,adminCookie;
    record Reply(int status,Map<String,Object> body,String cookie,String text,HttpHeaders headers){}
    String origin(){return "http://127.0.0.1:"+port;}
    String nextIp(){int n=IPS.incrementAndGet();return "198.51."+(n/250)+"."+(n%250+1);}
    @BeforeEach void reset(){
        ip=nextIp();clock.now=System.currentTimeMillis();crypto.afterHash=null;provider.sent.clear();provider.actions.clear();provider.failure=false;provider.email=true;provider.phone=true;
        db.transaction(c->{for(String table:List.of("connect_codes","connect_devices","email_codes","email_sends","contact_codes","contact_sends","invitation_audit","invitations","admin_audit","ai_points_ledger","ai_points","user_blocks","unverified_contacts","user_phones","sessions","files","comments","packs","users"))update(c,"DELETE FROM "+table);update(c,"UPDATE authentication_policy SET login_code=0,login_captcha=0,registration_code=1,registration_captcha=1,revision=0");update(c,"UPDATE registration_policy SET required=0");update(c,"UPDATE ai_signup_bonus SET amount=0");return null;});
        owner=seed("email","owner@example.test",false);admin=seed("email","admin@example.test",true);ownerCookie=cookie(owner);adminCookie=cookie(admin);
    }
    String seed(String channel,String value,boolean isAdmin){String id=UUID.randomUUID().toString(),encoded=crypto.password(PASSWORD);db.transaction(c->{update(c,"INSERT INTO users VALUES(?,?,?,?,?,?)",id,channel.equals("email")?value:null,"合成账号",encoded,isAdmin?1:0,"2026-10-25T00:00:00.000Z");if(channel.equals("phone"))update(c,"INSERT INTO user_phones VALUES(?,?,0)",id,value);return null;});return id;}
    String cookie(String id){String raw=AccountCrypto.token();db.transaction(c->{update(c,"INSERT INTO sessions VALUES(?,?,?)",AccountCrypto.sha(raw),id,clock.millis()+3600000);return null;});return "qfh_session="+raw;}
    Reply call(String path,String method,Object body,String cookie,boolean nativeClient) throws Exception {return call(path,method,body,cookie,nativeClient,Map.of());}
    @SuppressWarnings("unchecked") Reply call(String path,String method,Object body,String cookie,boolean nativeClient,Map<String,String> headers) throws Exception {
        var builder=HttpRequest.newBuilder(URI.create(origin()+path)).timeout(Duration.ofSeconds(20)).header("X-Real-IP",ip);
        if(!nativeClient)builder.header("Origin",headers.getOrDefault("Origin",origin()));if(cookie!=null)builder.header("Cookie",cookie);
        headers.forEach((key,value)->{if(!key.equals("Origin"))builder.header(key,value);});
        builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(body instanceof String?(String)body:JSON.writeValueAsString(body)));
        if(body!=null)builder.header("Content-Type","application/json");var response=client.send(builder.build(),HttpResponse.BodyHandlers.ofString());
        Map<String,Object> value=response.headers().firstValue("content-type").orElse("").contains("application/json")&&!response.body().isEmpty()?JSON.readValue(response.body(),Map.class):Map.of();
        return new Reply(response.statusCode(),value,response.headers().firstValue("set-cookie").orElse(null),response.body(),response.headers());
    }
    Reply post(String path,Object body,String cookie) throws Exception{return call(path,"POST",body,cookie,false);}
    void settings(boolean loginCode,boolean loginCaptcha,boolean registrationCode,boolean registrationCaptcha){db.transaction(c->{update(c,"UPDATE authentication_policy SET login_code=?,login_captcha=?,registration_code=?,registration_captcha=?",loginCode?1:0,loginCaptcha?1:0,registrationCode?1:0,registrationCaptcha?1:0);return null;});}
    long count(String table){return db.read(c->number(row(c,"SELECT COUNT(*) AS n FROM "+table).get("n")));}
    @SuppressWarnings("unchecked") Map<String,Object> user(Reply reply){return (Map<String,Object>)reply.body.get("user");}
    @Test void registrationCombinationsPreserveVerifiedFlagsAndRejectReplay() throws Exception {
        for(String channel:List.of("email","phone"))for(boolean code:List.of(false,true))for(boolean captcha:List.of(false,true)){
            ip=nextIp();settings(false,false,code,captcha);String target=channel.equals("email")?UUID.randomUUID()+"@example.test":"+86138"+String.format("%08d",IPS.get());var input=new HashMap<String,Object>(Map.of("identifier",target,"name","注册用户","password",PASSWORD,"captchaToken","valid"));
            if(code){var send=post("/api/auth/"+(channel.equals("email")?"email":"phone")+"-code",Map.of(channel,target,"captchaToken","valid"),null);assertEquals(200,send.status,send.text);input.put("code","wrong");assertEquals(400,post("/api/auth/register",input,null).status);input.put("code",provider.sent.get(target));}
            else if(captcha){input.put("captchaToken","bad");assertEquals(400,post("/api/auth/register",input,null).status);input.put("captchaToken","valid");}
            var reply=post("/api/auth/register",input,null);assertEquals(201,reply.status,reply.text);assertNotNull(reply.cookie);assertTrue(reply.cookie.contains("HttpOnly; SameSite=Lax; Max-Age=2592000"));assertEquals("注册用户",user(reply).get("name"));assertEquals(code?List.of():List.of(channel),user(reply).getOrDefault("unverifiedContacts",List.of()));
            String saved=db.read(c->(String)row(c,"SELECT password FROM users WHERE id=?",user(reply).get("id")).get("password"));assertTrue(crypto.matches(PASSWORD,saved));assertFalse(reply.text.contains(saved));
            var replay=post("/api/auth/register",input,null);assertTrue(replay.status==400||replay.status==409,replay.text);
        }
    }
    @Test void loginCombinationsRequirePasswordBeforeCodeAndCreateOnlyFinalSessions() throws Exception {
        for(String channel:List.of("email","phone"))for(boolean code:List.of(false,true))for(boolean captcha:List.of(false,true)){
            ip=nextIp();settings(code,captcha,true,true);String target=channel.equals("email")?UUID.randomUUID()+"@example.test":"+86139"+String.format("%08d",IPS.get());String id=seed(channel,target,false);db.transaction(c->{update(c,"INSERT INTO unverified_contacts VALUES(?,?,?)",id,channel,target);return null;});long before=count("sessions");
            var input=new HashMap<String,Object>(Map.of("identifier",target,"password","wrong-password","captchaToken","valid"));String endpoint=code?"/api/auth/login-code":"/api/auth/login";assertEquals(401,post(endpoint,input,null).status);assertEquals(before,count("sessions"));assertFalse(provider.sent.containsKey(target));input.put("password",PASSWORD);
            if(code){var send=post(endpoint,input,null);assertEquals(200,send.status,send.text);assertNull(send.cookie);assertEquals(before,count("sessions"));input.put("code",provider.sent.get(target));}
            else if(captcha){input.put("captchaToken","bad");assertEquals(400,post(endpoint,input,null).status);input.put("captchaToken","valid");}
            var login=post("/api/auth/login",input,null);assertEquals(200,login.status,login.text);assertEquals(id,user(login).get("id"));assertEquals(before+1,count("sessions"));assertEquals(code?List.of():List.of(channel),user(login).getOrDefault("unverifiedContacts",List.of()));
            String session=login.cookie.split(";",2)[0];var logout=post("/api/auth/logout",Map.of(),session);assertEquals(200,logout.status);assertTrue(logout.cookie.contains("Max-Age=0"));assertNull(call("/api/me","GET",null,session,false).body.get("user"));
        }
    }
    @Test void otpFailuresPersistAndTimeOutSendsKeepTheirReservation() throws Exception {
        settings(false,false,true,false);String email="attempts@example.test";assertEquals(200,post("/api/auth/email-code",Map.of("email",email),null).status);
        String correct=provider.sent.get(email);for(int i=0;i<5;i++)assertEquals(400,post("/api/auth/register",Map.of("email",email,"name","测试","password",PASSWORD,"code","wrong"),null).status);
        assertEquals(400,post("/api/auth/register",Map.of("email",email,"name","测试","password",PASSWORD,"code",correct),null).status);
        assertEquals(5L,db.<Long>read(c->number(row(c,"SELECT attempts FROM email_codes WHERE email_key=?",AccountCrypto.hmac(provider.pepper("email"),email)).get("attempts"))).longValue());
        provider.failure=true;clock.now+=61000;var failed=post("/api/auth/email-code",Map.of("email","timeout@example.test"),null);assertEquals(503,failed.status);long sends=count("email_sends");assertEquals(429,post("/api/auth/email-code",Map.of("email","timeout@example.test"),null).status);assertEquals(sends,count("email_sends"));
    }
    @Test void strengtheningCaptchaAfterSendingDoesNotCreateAnAccount() throws Exception {
        settings(false,false,true,false);String email="policy-change@example.test";assertEquals(200,post("/api/auth/email-code",Map.of("email",email),null).status);settings(false,false,true,true);
        var reply=post("/api/auth/register",Map.of("email",email,"name","测试","password",PASSWORD,"code",provider.sent.get(email)),null);assertEquals(409,reply.status);assertNull(reply.cookie);assertEquals(2,count("users"));
    }
    @Test void purposeIsolationAndExpiryRejectOldLoginProof() throws Exception {
        settings(true,false,true,false);String target="owner@example.test";assertEquals(200,post("/api/auth/login-code",Map.of("email",target,"password",PASSWORD),null).status);String code=provider.sent.get(target);long sessions=count("sessions");
        assertEquals(400,post("/api/auth/register",Map.of("email",target,"name","测试","password",PASSWORD,"code",code),null).status);
        clock.now+=600001;assertEquals(400,post("/api/auth/login",Map.of("email",target,"password",PASSWORD,"code",code),null).status);assertEquals(sessions,count("sessions"));
    }
    @Test void passwordVersionChangeInvalidatesAlreadySentLoginCode() throws Exception {
        settings(true,false,true,false);assertEquals(200,post("/api/auth/login-code",Map.of("email","owner@example.test","password",PASSWORD),null).status);String code=provider.sent.get("owner@example.test"),newPassword="new-synthetic-password";
        db.transaction(c->{update(c,"UPDATE users SET password=? WHERE id=?",crypto.password(newPassword),owner);return null;});long sessions=count("sessions");assertEquals(400,post("/api/auth/login",Map.of("email","owner@example.test","password",newPassword,"code",code),null).status);assertEquals(sessions,count("sessions"));
    }
    @Test void registrationRequirementsAreRecheckedAfterPasswordHashing() throws Exception {
        settings(false,false,false,false);crypto.afterHash=()->db.transaction(c->{update(c,"UPDATE authentication_policy SET registration_code=1");return null;});
        var changed=post("/api/auth/register",Map.of("email","hash-policy@example.test","name","测试","password",PASSWORD),null);assertEquals(409,changed.status);assertEquals(2,count("users"));assertEquals(2,count("sessions"));
        settings(false,false,false,false);crypto.afterHash=()->db.transaction(c->{update(c,"UPDATE registration_policy SET required=1");return null;});
        var invitation=post("/api/auth/register",Map.of("email","hash-invite@example.test","name","测试","password",PASSWORD),null);assertEquals(400,invitation.status);assertEquals(2,count("users"));assertEquals(0,count("ai_points_ledger"));
    }
    @Test void invitationRaceAndSignupBonusAreAtomic() throws Exception {
        settings(false,false,false,false);String invitation="QF-11111111-22222222-33333333-44444444";db.transaction(c->{update(c,"UPDATE registration_policy SET required=1");update(c,"UPDATE ai_signup_bonus SET amount=1234");update(c,"INSERT INTO invitations(id,digest,prefix,created_by,created,expires) VALUES(?,?,?,?,?,?)",UUID.randomUUID().toString(),AccountCrypto.sha(invitation),"QF-11111111",admin,clock.millis(),clock.millis()+3600000);return null;});
        var a=CompletableFuture.supplyAsync(()->{try{return post("/api/auth/register",Map.of("email","race-a@example.test","name","甲","password",PASSWORD,"invitationCode",invitation),null);}catch(Exception e){throw new CompletionException(e);}});
        var b=CompletableFuture.supplyAsync(()->{try{return post("/api/auth/register",Map.of("email","race-b@example.test","name","乙","password",PASSWORD,"invitationCode",invitation),null);}catch(Exception e){throw new CompletionException(e);}});
        var responses=List.of(a.get(),b.get());assertEquals(1,responses.stream().filter(reply->reply.status==201).count());assertEquals(3,count("users"));assertEquals(1,count("ai_points_ledger"));assertEquals(1234L,db.<Long>read(c->number(row(c,"SELECT SUM(balance) AS n FROM ai_points").get("n"))).longValue());assertEquals(1,count("invitation_audit"));
    }
    @Test void authPolicyIsAdminOnlyRevisionCheckedAndAudited() throws Exception {
        assertEquals(401,call("/api/admin/authentication","GET",null,null,false).status);assertEquals(403,call("/api/admin/authentication","GET",null,ownerCookie,false).status);
        assertEquals(403,call("/api/admin/authentication","PUT",Map.of("registrationCaptchaRequired",false),adminCookie,false,Map.of("Origin","https://untrusted.example")).status);
        assertEquals(200,call("/api/admin/authentication","PUT",Map.of("registrationCaptchaRequired",false,"revision",0),adminCookie,false).status);
        assertEquals(409,call("/api/admin/authentication","PUT",Map.of("registrationCodeRequired",false,"revision",0),adminCookie,false).status);
        db.transaction(c->{update(c,"CREATE TRIGGER fail_auth_audit BEFORE INSERT ON admin_audit WHEN NEW.action='authentication-policy-updated' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");return null;});
        try{assertEquals(500,call("/api/admin/authentication","PUT",Map.of("registrationCodeRequired",false,"invitationRequired",true,"revision",1),adminCookie,false).status);assertEquals(1L,db.<Long>read(c->number(row(c,"SELECT registration_code FROM authentication_policy").get("registration_code"))).longValue());assertEquals(0L,db.<Long>read(c->number(row(c,"SELECT required FROM registration_policy").get("required"))).longValue());}finally{db.transaction(c->{update(c,"DROP TRIGGER fail_auth_audit");return null;});}
    }
    @Test void bindingRetainsStableUserBalanceAndExistingDevice() throws Exception {
        var flow=connect(ownerCookie,"web");String token=(String)flow.get("token");db.transaction(c->{update(c,"INSERT INTO ai_points VALUES(?,?,?)",owner,9876,clock.millis());return null;});
        var input=new HashMap<String,Object>(Map.of("phone","13800138000","password",PASSWORD,"captchaToken","valid"));assertEquals(200,post("/api/account/contact-code",input,ownerCookie).status);input.put("code",provider.sent.get("+8613800138000"));var bound=post("/api/account/contact",input,ownerCookie);assertEquals(200,bound.status,bound.text);assertEquals(owner,user(bound).get("id"));assertEquals("+8613800138000",user(bound).get("phone"));
        var device=call("/api/connect/me","GET",null,null,true,Map.of("Authorization","Bearer "+token));assertEquals(200,device.status);assertFalse(device.text.contains("owner@example.test"));assertFalse(device.text.contains("13800138000"));assertTrue(device.text.contains("9876"));assertEquals(409,post("/api/account/contact",input,ownerCookie).status);
    }
    @Test void csrfJsonAndProviderFailuresDoNotCreateSessions() throws Exception {
        assertEquals(403,call("/api/auth/login","POST",Map.of("email","owner@example.test","password",PASSWORD),null,true).status);
        assertEquals(400,post("/api/auth/login","[]",null).status);assertEquals(400,post("/api/auth/login","{\"email\":\"a@example.test\",\"email\":\"b@example.test\"}",null).status);
        var huge=post("/api/auth/login",Map.of("padding","x".repeat(24001)),null);assertEquals(413,huge.status);
        provider.email=false;assertEquals(503,post("/api/auth/email-code",Map.of("email","no-service@example.test","captchaToken","valid"),null).status);assertEquals(2,count("sessions"));
    }
    Map<String,Object> grant(String cookie,String clientType) throws Exception {
        String verifier=AccountCrypto.urlToken(),state=AccountCrypto.urlToken(),redirect=clientType.equals("web")?"http://127.0.0.1:8787/hub/connect/callback":"quizforge://hub/connect";
        String query="v=1&client="+clientType+"&redirect_uri="+DefaultVerificationProvider.encode(redirect)+"&state="+state+"&code_challenge="+Base64.getUrlEncoder().withoutPadding().encodeToString(AccountCrypto.sha(AccountCrypto.utf8(verifier)))+"&code_challenge_method=S256&device_name="+DefaultVerificationProvider.encode("测试设备<script>");
        var page=call("/connect/authorize?"+query,"GET",null,cookie,false);assertEquals(200,page.status,page.text);assertTrue(page.text.contains("&lt;script&gt;"));var matcher=java.util.regex.Pattern.compile("data-request=\"([a-f0-9]{64})\"").matcher(page.text);assertTrue(matcher.find());
        var decision=post("/api/connect/authorize",Map.of("request",matcher.group(1),"decision","allow"),cookie);assertEquals(200,decision.status,decision.text);String location=(String)decision.body.get("redirect");String raw=location.substring(location.indexOf("code=")+5,location.indexOf("&state="));
        return new HashMap<String,Object>(Map.of("v",1,"client",clientType,"code",raw,"code_verifier",verifier,"redirect_uri",redirect));
    }
    Map<String,Object> connect(String cookie,String clientType) throws Exception {
        var input=grant(cookie,clientType);var token=call("/api/connect/token","POST",input,null,true);assertEquals(200,token.status,token.text);var result=new HashMap<>(token.body);result.put("exchange",input);return result;
    }
    @Test void pkceReplayBearerIsolationRenameRevokeAndExpiry() throws Exception {
        for(String kind:List.of("web","android")){
            var connected=connect(ownerCookie,kind);String token=(String)connected.get("token");var device=(Map<?,?>)connected.get("device");String id=(String)device.get("id");
            assertEquals(400,call("/api/connect/token","POST",connected.get("exchange"),null,true).status);assertEquals(401,call("/api/connect/me","GET",null,ownerCookie,false).status);
            assertEquals(200,call("/api/connect/devices/"+id,"PUT",Map.of("name","新设备"),ownerCookie,false).status);assertEquals(404,call("/api/connect/devices/"+id,"DELETE",null,adminCookie,false).status);
            assertEquals(204,call("/api/connect/logout","POST",null,null,true,Map.of("Authorization","Bearer "+token)).status);assertEquals(401,call("/api/connect/me","GET",null,null,true,Map.of("Authorization","Bearer "+token)).status);
        }
        var connected=connect(ownerCookie,"web");clock.now+=181L*86400000;assertEquals(401,call("/api/connect/me","GET",null,null,true,Map.of("Authorization","Bearer "+connected.get("token"))).status);
    }
    @Test void deviceCountIsCappedAndBlockedAccountsFailImmediately() throws Exception {
        for(int i=0;i<11;i++)connect(ownerCookie,"web");assertEquals(10L,db.<Long>read(c->number(row(c,"SELECT COUNT(*) AS n FROM connect_devices WHERE revoked=0").get("n"))).longValue());
        var connected=connect(ownerCookie,"android");db.transaction(c->{update(c,"INSERT INTO user_blocks VALUES(?,?,?,?)",owner,admin,"synthetic block",clock.millis());return null;});assertEquals(401,call("/api/connect/me","GET",null,null,true,Map.of("Authorization","Bearer "+connected.get("token"))).status);assertNull(call("/api/me","GET",null,ownerCookie,false).body.get("user"));
    }
    @Test void wrongPkceConsumesCodeAndConcurrentExchangeIssuesOnlyOneDevice() throws Exception {
        var input=grant(ownerCookie,"web");var bad=new HashMap<>(input);bad.put("code_verifier","z".repeat(43));assertEquals(400,call("/api/connect/token","POST",bad,null,true).status);assertEquals(400,call("/api/connect/token","POST",input,null,true).status);
        var race=grant(ownerCookie,"android");var a=CompletableFuture.supplyAsync(()->{try{return call("/api/connect/token","POST",race,null,true);}catch(Exception e){throw new CompletionException(e);}});var b=CompletableFuture.supplyAsync(()->{try{return call("/api/connect/token","POST",race,null,true);}catch(Exception e){throw new CompletionException(e);}});var responses=List.of(a.get(),b.get());assertEquals(1,responses.stream().filter(reply->reply.status==200).count());assertEquals(1,responses.stream().filter(reply->reply.status==400).count());assertEquals(1,count("connect_devices"));
        var expired=grant(ownerCookie,"web");clock.now+=120001;assertEquals(400,call("/api/connect/token","POST",expired,null,true).status);
    }
    @Test void consentLoginResumeAndMalformedQueriesNeverRedirectToUntrustedTargets() throws Exception {
        String verifier=AccountCrypto.urlToken(),query="v=1&client=web&redirect_uri="+DefaultVerificationProvider.encode("http://127.0.0.1:8787/hub/connect/callback")+"&state="+AccountCrypto.urlToken()+"&code_challenge="+Base64.getUrlEncoder().withoutPadding().encodeToString(AccountCrypto.sha(AccountCrypto.utf8(verifier)))+"&code_challenge_method=S256&device_name=test";
        var anonymous=call("/connect/authorize?"+query,"GET",null,null,false);assertEquals(303,anonymous.status);assertTrue(anonymous.headers.firstValue("Location").orElse("").matches("/manage/#connect-login/[a-f0-9]{64}"));assertEquals(200,call("/manage/","GET",null,null,false).status);
        assertEquals(400,call("/connect/authorize?"+query+"&state=duplicate","GET",null,ownerCookie,false).status);assertEquals(400,call("/connect/authorize?"+query.replace("client=web","client=attacker"),"GET",null,ownerCookie,false).status);
    }
    @AfterAll static void clean() throws Exception {try(var paths=Files.walk(DIRECTORY)){for(Path item:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(item);}}
}
