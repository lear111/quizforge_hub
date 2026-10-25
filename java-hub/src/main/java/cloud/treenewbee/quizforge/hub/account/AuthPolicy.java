package cloud.treenewbee.quizforge.hub.account;

import java.sql.*;
import java.time.Clock;
import java.util.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class AuthPolicy {
    public static final List<String> FIELDS=List.of("loginCodeRequired","loginCaptchaRequired","registrationCodeRequired","registrationCaptchaRequired","invitationRequired");
    private final HubDatabase database;private final VerificationProvider provider;private final Clock clock;
    public AuthPolicy(HubDatabase database,AuthSettings settings,VerificationProvider provider,Clock clock) {
        this.database=database;this.provider=provider;this.clock=clock;
        database.transaction(c -> { update(c,"INSERT OR IGNORE INTO registration_policy VALUES(1,?)",settings.enabled("INVITATION_REQUIRED")?1:0);return null; });
    }
    public Map<String,Object> get() { return database.read(this::get); }
    public Map<String,Object> get(Connection c) throws SQLException {
        var row=row(c,"SELECT * FROM authentication_policy WHERE id=1");var result=new LinkedHashMap<String,Object>();
        String[] columns={"login_code","login_captcha","registration_code","registration_captcha"};for(int i=0;i<4;i++)result.put(FIELDS.get(i),number(row.get(columns[i]))!=0);
        result.put("invitationRequired",number(row(c,"SELECT required FROM registration_policy WHERE id=1").get("required"))!=0);result.put("revision",row.get("revision"));return result;
    }
    public Map<String,Object> capabilities() { return database.read(c -> {
        boolean email=provider.available("email"),phone=provider.available("phone");
        return Map.of("emailCodeAvailable",email,"phoneCodeAvailable",phone,"captchaAvailable",provider.captchaReady(),"loginCodeAvailable",(email||phone)&&(email||row(c,"SELECT 1 FROM users WHERE email IS NOT NULL LIMIT 1")==null)&&(phone||row(c,"SELECT 1 FROM user_phones LIMIT 1")==null));
    }); }
    public Map<String,Object> set(Map<String,Object> input,Object actor) {
        if(input.keySet().stream().anyMatch(key -> !FIELDS.contains(key)&&!key.equals("revision")) || FIELDS.stream().noneMatch(input::containsKey) || FIELDS.stream().anyMatch(key -> input.containsKey(key)&&!(input.get(key) instanceof Boolean)))throw new HubException(400,"验证选项必须明确设置为开启或关闭");
        var available=capabilities();
        return database.transaction(c -> {
            var previous=get(c);var next=new LinkedHashMap<>(previous);next.putAll(input);
            if(input.containsKey("revision") && (!(input.get("revision") instanceof Number n)||n.doubleValue()!=n.longValue()||n.longValue()!=number(previous.get("revision"))))throw new HubException(409,"设置已被更新，请重新读取后再保存");
            for(String key:List.of("loginCodeRequired","registrationCodeRequired","loginCaptchaRequired","registrationCaptchaRequired")) if(Boolean.TRUE.equals(input.get(key))&&!Boolean.TRUE.equals(previous.get(key))) {
                boolean ready=key.equals("loginCodeRequired")?Boolean.TRUE.equals(available.get("loginCodeAvailable")):key.equals("registrationCodeRequired")?provider.available("email")||provider.available("phone"):provider.captchaReady();
                if(!ready)throw new HubException(400,"请先配置所需的验证码或人机验证服务");
            }
            if(FIELDS.stream().anyMatch(key -> !Objects.equals(previous.get(key),next.get(key)))) {
                update(c,"UPDATE registration_policy SET required=? WHERE id=1",Boolean.TRUE.equals(next.get("invitationRequired"))?1:0);
                update(c,"UPDATE authentication_policy SET login_code=?,login_captcha=?,registration_code=?,registration_captcha=?,revision=revision+1 WHERE id=1",Boolean.TRUE.equals(next.get("loginCodeRequired"))?1:0,Boolean.TRUE.equals(next.get("loginCaptchaRequired"))?1:0,Boolean.TRUE.equals(next.get("registrationCodeRequired"))?1:0,Boolean.TRUE.equals(next.get("registrationCaptchaRequired"))?1:0);
                String detail=JsonMapper.builder().build().writeValueAsString(Map.of("previous",previous,"replacement",get(c)));
                update(c,"INSERT INTO admin_audit VALUES (?,?,?,?,?,?)",UUID.randomUUID().toString(),actor,"authentication","authentication-policy-updated",detail,clock.millis());
            }
            return Map.of("policy",get(c),"capabilities",available);
        });
    }
    public static boolean on(Map<String,Object> policy,String field) { return Boolean.TRUE.equals(policy.get(field)); }
}
