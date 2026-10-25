package cloud.treenewbee.quizforge.hub.account;

import java.sql.*;
import java.time.Clock;
import java.util.*;
import org.springframework.stereotype.Service;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static cloud.treenewbee.quizforge.hub.account.AccountCrypto.*;

@Service
public class VerificationCodes {
    @FunctionalInterface public interface VerifiedWork<T> { T run(Connection c,boolean captchaVerified) throws SQLException; }
    private record Keys(boolean emailRegistration,String channel,String addressKey,String subject,String ipKey,String pepper) {}
    private record Outcome<T>(T value,HubException error) {}
    private final HubDatabase database;private final VerificationProvider provider;private final Clock clock;private final int dailySms;
    public VerificationCodes(HubDatabase database,VerificationProvider provider,Clock clock,AuthSettings settings) { this.database=database;this.provider=provider;this.clock=clock;dailySms=settings.integer("SMS_DAILY_LIMIT",100,1,10000); }
    private Keys keys(Contact contact,String purpose,String ip) {
        if(!provider.available(contact.channel()))throw new HubException(503,contact.channel().equals("phone")?"手机验证暂未开放，请使用邮箱":"邮箱验证暂未开放，请稍后再试");
        String pepper=provider.pepper(contact.channel()),address=hmac(pepper,contact.value());boolean legacy=contact.channel().equals("email")&&purpose.equals("register");
        return new Keys(legacy,contact.channel(),address,legacy?address:hmac(pepper,purpose+":"+contact.value()),hmac(pepper,ip),pepper);
    }
    private void limits(Connection c,Keys key,long now) throws SQLException {
        String table=key.emailRegistration?"email_sends":"contact_sends",prefix=key.emailRegistration?"":"channel=? AND ",address=key.emailRegistration?"email_key":"address_key";
        var common=new ArrayList<Object>();if(!key.emailRegistration)common.add(key.channel);
        for(var limit:List.of(new Object[]{address+"=? AND created>?",key.addressKey,now-60000,1L},new Object[]{address+"=? AND created>?",key.addressKey,now-86400000,5L},new Object[]{"ip_key=? AND created>?",key.ipKey,now-600000,5L},new Object[]{"ip_key=? AND created>?",key.ipKey,now-86400000,20L})) {
            var args=new ArrayList<>(common);args.add(limit[1]);args.add(limit[2]);if(number(row(c,"SELECT COUNT(*) AS n FROM "+table+" WHERE "+prefix+limit[0],args.toArray()).get("n"))>=(long)limit[3])throw new HubException(429,"验证码发送太频繁，请稍后重试");
        }
        var args=new ArrayList<>(common);args.add(now-86400000);if(number(row(c,"SELECT COUNT(*) AS n FROM "+table+" WHERE "+prefix+"created>?",args.toArray()).get("n"))>=(key.channel.equals("phone")?dailySms:100))throw new HubException(429,"今天的验证发送额度已用完，请稍后再来");
    }
    public boolean captcha(String token,String ip,String hostname,String action) { boolean valid=false;try{valid=provider.verify(token,ip,hostname,action);}catch(RuntimeException ignored){}if(!valid)throw new HubException(400,"人机验证未通过，请重试");return true; }
    public void send(Contact contact,String purpose,String ip,String token,String hostname,boolean eligible,boolean captchaRequired,String action) {
        Keys key=keys(contact,purpose,ip);database.read(c -> { limits(c,key,clock.millis());return null; });
        boolean verified=captchaRequired&&captcha(token,ip,hostname,action);long time=clock.millis();String nonce=UUID.randomUUID().toString(),code=code();
        String fingerprint=hmac(key.pepper,nonce+":"+(key.emailRegistration?contact.value():key.subject)+":"+code);
        database.transaction(c -> {
            limits(c,key,time);
            if(key.emailRegistration){update(c,"DELETE FROM email_sends WHERE created<=?",time-86400000);update(c,"DELETE FROM email_codes WHERE expires<=?",time);update(c,"INSERT INTO email_sends VALUES (?,?,?,?)",nonce,key.addressKey,key.ipKey,time);update(c,"INSERT INTO email_codes(email_key,nonce,digest,expires,attempts,state,captcha_verified) VALUES(?,?,?,?,0,'pending',?) ON CONFLICT(email_key) DO UPDATE SET nonce=excluded.nonce,digest=excluded.digest,expires=excluded.expires,attempts=0,state='pending',captcha_verified=excluded.captcha_verified",key.subject,nonce,fingerprint,time+600000,verified?1:0);}
            else {update(c,"DELETE FROM contact_sends WHERE created<=?",time-86400000);update(c,"DELETE FROM contact_codes WHERE expires<=?",time);update(c,"INSERT INTO contact_sends VALUES(?,?,?,?,?)",nonce,key.channel,key.addressKey,key.ipKey,time);update(c,"INSERT INTO contact_codes(channel,subject,nonce,digest,expires,attempts,state,captcha_verified) VALUES(?,?,?,?,?,0,'pending',?) ON CONFLICT(channel,subject) DO UPDATE SET nonce=excluded.nonce,digest=excluded.digest,expires=excluded.expires,attempts=0,state='pending',captcha_verified=excluded.captcha_verified",key.channel,key.subject,nonce,fingerprint,time+600000,verified?1:0);}return null;
        });
        try { if(eligible)provider.send(contact,code,nonce,purpose);state(key,nonce,eligible?"sent":"failed"); }
        catch(RuntimeException error){state(key,nonce,"failed");throw new HubException(503,"验证码暂时无法发送，请稍后重新获取");}
    }
    private void state(Keys key,String nonce,String state) { database.transaction(c -> {if(key.emailRegistration)update(c,"UPDATE email_codes SET state=? WHERE email_key=? AND nonce=? AND state='pending'",state,key.subject,nonce);else update(c,"UPDATE contact_codes SET state=? WHERE channel=? AND subject=? AND nonce=? AND state='pending'",state,key.channel,key.subject,nonce);return null;}); }
    public <T> T consume(Contact contact,String purpose,Object code,VerifiedWork<T> work) {
        Keys key=keys(contact,purpose,"");String table=key.emailRegistration?"email_codes":"contact_codes",where=key.emailRegistration?"email_key=?":"channel=? AND subject=?";Object[] args=key.emailRegistration?new Object[]{key.subject}:new Object[]{key.channel,key.subject};
        Outcome<T> outcome=database.transaction(c -> {
            var record=row(c,"SELECT * FROM "+table+" WHERE "+where,args);
            if(record==null||!"sent".equals(record.get("state"))||number(record.get("expires"))<=clock.millis()||number(record.get("attempts"))>=5)return new Outcome<T>(null,new HubException(400,"验证码无效或已失效，请重新获取"));
            String raw=code==null?"":String.valueOf(code),candidate=hmac(key.pepper,record.get("nonce")+":"+(key.emailRegistration?contact.value():key.subject)+":"+raw);
            if(!raw.matches("[0-9]{6}")||!equal(candidate,(String)record.get("digest"))){update(c,"UPDATE "+table+" SET attempts=attempts+1 WHERE "+where,args);return new Outcome<T>(null,new HubException(400,"验证码不正确，请重新输入"));}
            T value=work.run(c,number(record.get("captcha_verified"))!=0);update(c,"UPDATE "+table+" SET state='consumed' WHERE "+where,args);return new Outcome<T>(value,null);
        });
        if(outcome.error!=null)throw outcome.error;return outcome.value;
    }
}
