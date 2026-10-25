package cloud.treenewbee.quizforge.hub.account;

import java.sql.*;
import java.time.*;
import java.util.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Service;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static cloud.treenewbee.quizforge.hub.account.AccountStore.*;
import static cloud.treenewbee.quizforge.hub.account.AuthPolicy.on;

@Service
public class AccountService {
    public record Login(String token,Map<String,Object> user) {}
    private final HubDatabase database;private final AccountCrypto crypto;private final AuthPolicy policy;private final VerificationCodes codes;private final VerificationProvider provider;private final Clock clock;private final AccountHttp http;private final AuthSettings settings;private final HubProperties hub;private final cloud.treenewbee.quizforge.hub.ai.AiUpstreams ai;
    public AccountService(HubDatabase database,AccountCrypto crypto,AuthPolicy policy,VerificationCodes codes,VerificationProvider provider,Clock clock,AccountHttp http,AuthSettings settings,HubProperties hub,cloud.treenewbee.quizforge.hub.ai.AiUpstreams ai) { this.database=database;this.crypto=crypto;this.policy=policy;this.codes=codes;this.provider=provider;this.clock=clock;this.http=http;this.settings=settings;this.hub=hub;this.ai=ai; }
    public Map<String,Object> config() {
        var selected=policy.get();boolean useProvider=on(selected,"registrationCodeRequired")||on(selected,"loginCodeRequired");
        var methods=Map.of("email",!useProvider||provider.available("email"),"phone",!useProvider||provider.available("phone"));
        boolean ready=(!on(selected,"registrationCaptchaRequired")||provider.captchaReady())&&(methods.get("email")||methods.get("phone"));
        return DefaultVerificationProvider.object("maxArchiveMB",20,"registrationReady",ready,"registrationMethods",ready?methods:Map.of("email",false,"phone",false),"verificationMethods",Map.of("email",provider.available("email"),"phone",provider.available("phone")),"captchaReady",provider.captchaReady(),"authPolicy",selected,"invitationRequired",selected.get("invitationRequired"),"turnstileSiteKey",provider.siteKey(),"cloudEnabled",hub.cloudEnabled()||settings.enabled("PRACTICE_BRIDGE_ENABLED")&&!hub.practiceOrigin().isEmpty(),"practiceOrigin",hub.practiceOrigin(),"adminEnabled",settings.enabled("ADMIN_ENABLED"),"localImport",Map.of("enabled",hub.localImportEnabled(),"protocolVersion",1,"scheme","quizforge"),"officialAi",Map.of("enabled",ai.enabled(),"protocolVersion",1));
    }
    private Map<String,Object> authenticate(Contact contact,String plain) {
        var user=database.read(c -> account(c,contact));
        if(!crypto.matches(plain,user==null?null:(String)user.get("password"))||user==null||database.read(c -> blocked(c,user.get("id"))))throw new HubException(401,"账号或密码不正确，或账号已停用");return user;
    }
    private String loginPurpose(Map<String,Object> user) { return "login:"+user.get("id")+":"+AccountCrypto.sha((String)user.get("password")); }
    private void invitation(Connection c,Object raw,String newUser) throws SQLException {
        if(!(raw instanceof String code)||!code.strip().toUpperCase(Locale.ROOT).matches("QF-(?:[A-F0-9]{8}-){3}[A-F0-9]{8}"))throw new HubException(400,"邀请码无效、已使用或已停用");
        var invite=row(c,"SELECT * FROM invitations WHERE digest=?",AccountCrypto.sha(code.strip().toUpperCase(Locale.ROOT)));long now=clock.millis();
        if(invite==null||invite.get("used")!=null||invite.get("revoked")!=null||number(invite.get("expires"))<=now)throw new HubException(400,"邀请码无效、已使用或已停用");
        if(newUser!=null){if(update(c,"UPDATE invitations SET used=?,user_id=? WHERE id=? AND used IS NULL AND revoked IS NULL AND expires>?",now,newUser,invite.get("id"),now)!=1)throw new HubException(400,"邀请码无效、已使用或已停用");update(c,"INSERT INTO invitation_audit VALUES(?,?,?,?,?)",UUID.randomUUID().toString(),invite.get("id"),newUser,"redeem",now);}
    }
    private Login session(Connection c,Object id) throws SQLException {
        String token=AccountCrypto.token();update(c,"DELETE FROM sessions WHERE expires<=?",clock.millis());update(c,"INSERT INTO sessions VALUES(?,?,?)",AccountCrypto.sha(token),id,clock.millis()+30L*86400000);return new Login(token,profile(c,id));
    }
    public void registrationCode(Map<String,Object> input,HttpServletRequest request,String channel) {
        var current=policy.get();if(!on(current,"registrationCodeRequired"))throw new HubException(400,"注册当前无需验证码，请直接提交注册");
        var contact=Contact.parse(input);if(!channel.equals(contact.channel()))throw new HubException(400,"联系方式格式不正确");
        if(on(current,"invitationRequired"))database.read(c -> {invitation(c,input.get("invitationCode"),null);return null;});
        boolean eligible=database.read(c -> account(c,contact)==null);
        codes.send(contact,"register",http.ip(request),input.get("captchaToken") instanceof String s?s:null,http.hostname(request),eligible,on(current,"registrationCaptchaRequired"),"register_"+channel);
    }
    public Login register(Map<String,Object> input,HttpServletRequest request) {
        var contact=Contact.parse(input);String plain=AccountHttp.password(input),name=AccountHttp.text(input,"name",1,30,"用户名");var initial=policy.get();
        if((on(initial,"registrationCodeRequired")||on(initial,"loginCodeRequired"))&&!provider.available(contact.channel()))throw new HubException(503,"所选联系方式的验证服务暂未开放");
        boolean captcha=on(initial,"registrationCaptchaRequired")&&!on(initial,"registrationCodeRequired")&&codes.captcha(input.get("captchaToken") instanceof String s?s:null,http.ip(request),http.hostname(request),"register_"+contact.channel());
        if(on(initial,"invitationRequired"))database.read(c -> {invitation(c,input.get("invitationCode"),null);return null;});
        String encoded=crypto.password(plain),id=UUID.randomUUID().toString();
        VerificationCodes.VerifiedWork<Login> create=(c,captchaVerified) -> {
            var latest=policy.get(c);boolean verified=on(initial,"registrationCodeRequired");
            if(on(latest,"registrationCodeRequired")&&!verified||on(latest,"registrationCaptchaRequired")&&!captchaVerified)throw new HubException(409,"注册设置已更新，请按最新要求完成验证");
            if(account(c,contact)!=null)throw new HubException(409,"该联系方式已注册，请直接登录");
            update(c,"INSERT INTO users(id,email,name,password,created) VALUES(?,?,?,?,?)",id,contact.channel().equals("email")?contact.value():null,name,encoded,clock.instant().toString());
            if(contact.channel().equals("phone"))update(c,"INSERT INTO user_phones VALUES(?,?,?)",id,contact.value(),verified?clock.millis():0);
            verified(c,id,contact,verified,clock.millis());if(on(latest,"invitationRequired"))invitation(c,input.get("invitationCode"),id);
            long bonus=number(row(c,"SELECT amount FROM ai_signup_bonus WHERE id=1").get("amount"));
            if(bonus>0){update(c,"INSERT INTO ai_points VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET balance=balance+excluded.balance,updated=excluded.updated",id,bonus,clock.millis());update(c,"INSERT INTO ai_points_ledger VALUES(?,?,?,?,?,?)",UUID.randomUUID().toString(),id,bonus,"signup","新用户赠送",clock.millis());}
            return session(c,id);
        };
        return on(initial,"registrationCodeRequired")?codes.consume(contact,"register",input.get("code"),create):database.transaction(c -> create.run(c,captcha));
    }
    public void loginCode(Map<String,Object> input,HttpServletRequest request) {
        var selected=policy.get();if(!on(selected,"loginCodeRequired"))throw new HubException(400,"登录当前无需验证码，请直接登录");
        var contact=Contact.parse(input);var user=authenticate(contact,AccountHttp.password(input));
        codes.send(contact,loginPurpose(user),http.ip(request),input.get("captchaToken") instanceof String s?s:null,http.hostname(request),true,on(selected,"loginCaptchaRequired"),"login_"+contact.channel());
    }
    public Login login(Map<String,Object> input,HttpServletRequest request) {
        var contact=Contact.parse(input);String plain=AccountHttp.password(input);var selected=policy.get();
        boolean captcha=on(selected,"loginCaptchaRequired")&&!on(selected,"loginCodeRequired")&&codes.captcha(input.get("captchaToken") instanceof String s?s:null,http.ip(request),http.hostname(request),"login_"+contact.channel());
        var user=authenticate(contact,plain);
        VerificationCodes.VerifiedWork<Login> finish=(c,captchaVerified) -> {
            var current=policy.get(c);var latest=account(c,contact);
            if(on(current,"loginCodeRequired")&&!on(selected,"loginCodeRequired")||on(current,"loginCaptchaRequired")&&!captchaVerified)throw new HubException(409,"登录设置已更新，请按最新要求完成验证");
            if(latest==null||!Objects.equals(user.get("id"),latest.get("id"))||!Objects.equals(user.get("password"),latest.get("password"))||blocked(c,user.get("id")))throw new HubException(401,"账号或密码不正确，或账号已停用");
            if(on(selected,"loginCodeRequired"))verified(c,user.get("id"),contact,true,clock.millis());return session(c,user.get("id"));
        };
        return on(selected,"loginCodeRequired")?codes.consume(contact,loginPurpose(user),input.get("code"),finish):database.transaction(c -> finish.run(c,captcha));
    }
    public Map<String,Object> bind(Map<String,Object> input,HttpServletRequest request,Object userId,boolean send) {
        var contact=Contact.parse(input);String plain=AccountHttp.password(input);var user=database.read(c -> row(c,"SELECT * FROM users WHERE id=?",userId));
        if(user==null||!crypto.matches(plain,(String)user.get("password")))throw new HubException(401,"请填写当前账号的正确密码");
        database.read(c -> { bindingAllowed(c,userId,contact,user);return null; });
        if(send){codes.send(contact,"bind:"+userId,http.ip(request),input.get("captchaToken") instanceof String s?s:null,http.hostname(request),true,true,"bind_contact");return Map.of("message","验证码已发送，请查收。","retryAfter",60);}
        return codes.consume(contact,"bind:"+userId,input.get("code"),(c,captchaVerified) -> {
            if(!captchaVerified)throw new HubException(409,"请完成人机验证后重新获取验证码");bindingAllowed(c,userId,contact,user);
            if(contact.channel().equals("phone"))update(c,"INSERT INTO user_phones VALUES(?,?,?)",userId,contact.value(),clock.millis());else update(c,"UPDATE users SET email=? WHERE id=?",contact.value(),userId);
            verified(c,userId,contact,true,clock.millis());return Map.of("user",profile(c,userId));
        });
    }
    private void bindingAllowed(Connection c,Object id,Contact contact,Map<String,Object> authenticated) throws SQLException {
        var latest=row(c,"SELECT password FROM users WHERE id=?",id);
        if(latest==null||blocked(c,id)||!Objects.equals(latest.get("password"),authenticated.get("password")))throw new HubException(401,"账号状态已变化，请重新登录");
        if(profile(c,id).get(contact.channel())!=null)throw new HubException(409,"此类联系方式已绑定，暂不支持换绑");if(account(c,contact)!=null)throw new HubException(409,"该联系方式无法绑定，请使用其他联系方式");
    }
    public void logout(String raw) { if(raw!=null)database.transaction(c -> {update(c,"DELETE FROM sessions WHERE token=?",AccountCrypto.sha(raw));return null;}); }
}
