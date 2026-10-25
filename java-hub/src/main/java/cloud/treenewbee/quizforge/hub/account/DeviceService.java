package cloud.treenewbee.quizforge.hub.account;

import java.sql.*;
import java.time.*;
import java.time.format.DateTimeFormatterBuilder;
import java.util.*;
import org.springframework.stereotype.Service;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static cloud.treenewbee.quizforge.hub.account.AccountCrypto.*;

@Service
public class DeviceService {
    public record Pending(String client,String redirect,String state,String challenge,String name,long expires) {}
    public record Consent(String key,Pending request) {}
    private record Exchange(Map<String,Object> value,DeviceException error) {}
    private final HubDatabase database;private final AuthSettings settings;private final Clock clock;private final cloud.treenewbee.quizforge.hub.ai.AiUpstreams ai;
    private final Map<String,Pending> pending=new HashMap<>();
    private static final long DAY=86400000L;
    public DeviceService(HubDatabase database,AuthSettings settings,Clock clock,cloud.treenewbee.quizforge.hub.ai.AiUpstreams ai){this.database=database;this.settings=settings;this.clock=clock;this.ai=ai;}
    public boolean enabled(){return settings.enabled("HUB_DEVICE_CONNECT_ENABLED")||database.read(c -> row(c,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='official_ai_config'")!=null&&row(c,"SELECT 1 FROM official_ai_config WHERE id=1 AND enabled=1")!=null);}
    public void requireEnabled(){if(!enabled())throw new DeviceException(404,"OFFICIAL_AI_DISABLED","设备连接暂未开放");}
    private static DeviceException rejected(int status,String message){return new DeviceException(status,"CONNECT_REQUEST_REJECTED",message);}
    public static boolean redirectAllowed(String client,String uri){
        if(client==null||uri==null)return false;
        if(client.equals("android"))return uri.equals("quizforge://hub/connect");if(!client.equals("web"))return false;
        var match=java.util.regex.Pattern.compile("^http://(?:127\\.0\\.0\\.1|localhost):([1-9][0-9]{3,4})/hub/connect/callback$").matcher(uri);return match.matches()&&Integer.parseInt(match.group(1))>=1024&&Integer.parseInt(match.group(1))<=65535;
    }
    public static String name(Object raw){if(!(raw instanceof String text))throw rejected(400,"设备名称请填写 1–40 个字符");String value=text.replaceAll("[\\x00-\\x1f\\x7f-\\x9f]","").strip();if(value.isEmpty()||value.codePointCount(0,value.length())>40)throw rejected(400,"设备名称请填写 1–40 个字符");return value;}
    private synchronized void sweep(){long now=clock.millis();pending.entrySet().removeIf(entry -> entry.getValue().expires<=now);database.transaction(c -> {update(c,"DELETE FROM connect_codes WHERE expires<=?",now);return null;});}
    public synchronized Consent authorize(Map<String,String[]> params){
        requireEnabled();sweep();
        if(params.size()==1&&params.containsKey("request")){String[] keys=params.get("request");Pending value=keys.length==1?pending.get(keys[0]):null;if(value==null)throw rejected(400,"连接请求已过期，请回到 QuizForge 重新点击登录");return new Consent(keys[0],value);}
        var fields=Set.of("v","client","redirect_uri","state","code_challenge","code_challenge_method","device_name");
        if(!params.keySet().equals(fields)||params.values().stream().anyMatch(values -> values.length!=1))throw rejected(400,"连接请求无效，请回到 QuizForge 重新点击登录");
        String client=params.get("client")[0],redirect=params.get("redirect_uri")[0],state=params.get("state")[0],challenge=params.get("code_challenge")[0];
        if(!params.get("v")[0].equals("1")||!redirectAllowed(client,redirect)||!state.matches("[A-Za-z0-9._~-]{22,256}")||!challenge.matches("[A-Za-z0-9_-]{43}")||!params.get("code_challenge_method")[0].equals("S256"))throw rejected(400,"连接请求无效，请回到 QuizForge 重新点击登录");
        if(pending.size()>=5000)throw rejected(503,"服务繁忙，请稍后再试");String key=token();var entry=new Pending(client,redirect,state,challenge,name(params.get("device_name")[0]),clock.millis()+600000);pending.put(key,entry);return new Consent(key,entry);
    }
    private String redirect(Pending request,String field,String value){return request.redirect+"?"+field+"="+DefaultVerificationProvider.encode(value)+"&state="+DefaultVerificationProvider.encode(request.state);}
    public synchronized Map<String,Object> decision(Map<String,Object> input,Object user){
        requireEnabled();sweep();String key=input.get("request") instanceof String s?s:"";var entry=pending.get(key);if(entry==null)throw rejected(410,"连接请求已过期，请回到 QuizForge 重新点击登录");
        if(!(input.get("decision") instanceof String decision)||!Set.of("allow","deny").contains(decision))throw rejected(400,"请选择允许或拒绝");pending.remove(key);
        if(input.get("decision").equals("deny"))return Map.of("redirect",redirect(entry,"error","access_denied"));
        String code=urlToken();database.transaction(c -> {if(AccountStore.blocked(c,user)||row(c,"SELECT 1 FROM users WHERE id=?",user)==null)throw rejected(403,"账号已停用，无法连接设备");update(c,"INSERT INTO connect_codes VALUES(?,?,?,?,?,?,?)",sha(code),user,entry.client,entry.redirect,entry.challenge,entry.name,clock.millis()+120000);return null;});
        return Map.of("redirect",redirect(entry,"code",code));
    }
    public Map<String,Object> exchange(Map<String,Object> input){
        requireEnabled();
        if(!input.keySet().equals(Set.of("v","client","code","code_verifier","redirect_uri"))||!(input.get("v") instanceof Number n)||n.doubleValue()!=1)throw new DeviceException(400,"INVALID_GRANT","换取设备令牌的请求无效");
        String raw=input.get("code") instanceof String s&&s.matches("[A-Za-z0-9_-]{43}")?s:null;
        String verifier=input.get("code_verifier") instanceof String s&&s.matches("[A-Za-z0-9._~-]{43,128}")?s:null;
        Exchange result=database.transaction(c -> {
            var grant=raw==null?null:row(c,"SELECT * FROM connect_codes WHERE code=?",sha(raw));if(grant!=null)update(c,"DELETE FROM connect_codes WHERE code=?",sha(raw));
            String challenge=verifier==null?null:Base64.getUrlEncoder().withoutPadding().encodeToString(sha(utf8(verifier)));
            if(grant==null||number(grant.get("expires"))<=clock.millis()||!Objects.equals(grant.get("client"),input.get("client"))||!Objects.equals(grant.get("redirect_uri"),input.get("redirect_uri"))||!equal((String)grant.get("challenge"),challenge)||AccountStore.blocked(c,grant.get("user_id")))return new Exchange(null,new DeviceException(400,"INVALID_GRANT","授权已过期或无效，请重新登录"));
            String token="qfd_"+urlToken(),id=UUID.randomUUID().toString(),created=iso(clock.millis());Object user=grant.get("user_id");
            update(c,"INSERT INTO connect_devices(id,user_id,token,name,client,created,last_used) VALUES(?,?,?,?,?,?,?)",id,user,sha(token),grant.get("device_name"),grant.get("client"),created,clock.millis());
            for(var old:rows(c,"SELECT id FROM connect_devices WHERE user_id=? AND revoked=0 ORDER BY last_used DESC,created DESC LIMIT -1 OFFSET 10",user))update(c,"UPDATE connect_devices SET revoked=1 WHERE id=?",old.get("id"));
            return new Exchange(Map.of("token",token,"device",Map.of("id",id,"name",grant.get("device_name"),"client",grant.get("client"),"created",created),"user",Map.of("name",row(c,"SELECT name FROM users WHERE id=?",user).get("name"))),null);
        });
        if(result.error!=null)throw result.error;return result.value;
    }
    public Map<String,Object> device(String authorization){
        requireEnabled();String raw=authorization!=null&&authorization.matches("Bearer qfd_[A-Za-z0-9_-]{43}")?authorization.substring(7):null;
        if(raw==null)throw invalid();return database.transaction(c -> {
            var entry=row(c,"SELECT d.*,u.name AS user_name FROM connect_devices d JOIN users u ON u.id=d.user_id WHERE d.token=? AND d.revoked=0",sha(raw));
            if(entry==null||number(entry.get("last_used"))<=clock.millis()-180*DAY||AccountStore.blocked(c,entry.get("user_id")))throw invalid();
            if(clock.millis()-number(entry.get("last_used"))>60000)update(c,"UPDATE connect_devices SET last_used=? WHERE id=?",clock.millis(),entry.get("id"));return entry;
        });
    }
    private DeviceException invalid(){return new DeviceException(401,"DEVICE_TOKEN_INVALID","设备登录已失效，请在 AI 设置中重新登录");}
    private static String iso(long time){return new DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.ofEpochMilli(time));}
    private static Map<String,Object> dto(Map<String,Object> row,boolean last){var value=new LinkedHashMap<String,Object>();for(String field:List.of("id","name","client","created"))value.put(field,row.get(field));if(last)value.put("lastUsed",iso(number(row.get("last_used"))));return value;}
    public Map<String,Object> me(String bearer){var entry=device(bearer);long balance=database.read(c -> {var value=row(c,"SELECT balance FROM ai_points WHERE user_id=?",entry.get("user_id"));return value==null?0:number(value.get("balance"));});return Map.of("user",Map.of("name",entry.get("user_name")),"device",dto(entry,false),"ai",ai.usage(entry.get("user_id")));}
    public void logout(String bearer){var entry=device(bearer);database.transaction(c -> {update(c,"UPDATE connect_devices SET revoked=1 WHERE id=?",entry.get("id"));return null;});}
    public Map<String,Object> list(Object user){requireEnabled();return database.read(c -> Map.of("devices",rows(c,"SELECT * FROM connect_devices WHERE user_id=? AND revoked=0 AND last_used>? ORDER BY last_used DESC",user,clock.millis()-180*DAY).stream().map(row -> dto(row,true)).toList()));}
    public Map<String,Object> change(Object user,String id,Object name,boolean revoke){requireEnabled();return database.transaction(c -> {var entry=row(c,"SELECT * FROM connect_devices WHERE id=? AND user_id=? AND revoked=0",id,user);if(entry==null)throw rejected(404,"设备不存在或已撤销");if(revoke){update(c,"UPDATE connect_devices SET revoked=1 WHERE id=?",id);return Map.of("ok",true);}String renamed=name(name);update(c,"UPDATE connect_devices SET name=? WHERE id=?",renamed,id);entry.put("name",renamed);return Map.of("device",dto(entry,true));});}
    public static String escape(Object value){return String.valueOf(value).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&#39;");}
    public String page(Consent consent,Map<String,Object> user){return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>授权登录 · QuizForge</title><link rel=\"stylesheet\" href=\"/hub.css\"><link rel=\"stylesheet\" href=\"/account.css\"><script type=\"module\" src=\"/device-consent.js\"></script></head><body><main class=\"account-consent\"><section class=\"account-panel\" data-request=\""+consent.key+"\"><h1>授权这台设备登录？</h1><dl><dt>设备</dt><dd>"+escape(consent.request.name)+"（"+(consent.request.client.equals("web")?"电脑":"Android")+"）</dd><dt>账号</dt><dd>"+escape(user.get("name"))+"</dd></dl><p>授权后，这台设备将以你的账号登录 QuizForge。你可以在用户中心撤销设备连接。</p><div class=\"account-actions\"><button class=\"btn-filled\" data-decision=\"allow\">授权登录</button><button class=\"btn-outline\" data-decision=\"deny\">取消</button></div><p class=\"account-error\" role=\"alert\"></p></section></main></body></html>";}
}
