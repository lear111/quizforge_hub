package cloud.treenewbee.quizforge.hub.admin;

import jakarta.servlet.http.HttpServletRequest;
import java.sql.*;
import java.util.*;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.delivery.RequestLimit;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Component
public class AdminAccess {
    private final SessionIdentity identity;private final AuthSettings settings;private final RequestLimit limits;
    private static final JsonMapper JSON=JsonMapper.builder().build();
    public AdminAccess(SessionIdentity identity,AuthSettings settings,RequestLimit limits){this.identity=identity;this.settings=settings;this.limits=limits;}
    public Map<String,Object> require(HttpServletRequest request){if(!settings.enabled("ADMIN_ENABLED"))throw new HubException(404,"管理后台尚未开放");var user=identity.admin(request);limits.check(request,"admin",120,user.get("id").toString());return user;}
    public static void current(Connection c,Object actor)throws SQLException {if(row(c,"SELECT id FROM users WHERE id=? AND admin<>0 AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=users.id)",actor)==null)throw new HubException(403,"管理员权限已失效，请重新登录");}
    public static void audit(Connection c,Object actor,String action,String target,Object detail)throws SQLException {current(c,actor);update(c,"INSERT INTO admin_audit VALUES(?,?,?,?,?,?)",UUID.randomUUID().toString(),actor,target,action,JSON.writeValueAsString(detail),System.currentTimeMillis());}
    public static String text(Object raw,int max,String message){if(!(raw instanceof String text))throw new HubException(400,message);String value=text.strip();if(value.isEmpty()||value.length()>max)throw new HubException(400,message);return value;}
    public static String reason(Map<String,Object> input){return text(input.get("reason"),1000,"请填写 1–1000 字的操作原因");}
    public static long integer(Object raw,long min,long max,String message){if(!(raw instanceof Number n)||!Double.isFinite(n.doubleValue())||n.doubleValue()!=n.longValue()||n.longValue()<min||n.longValue()>max)throw new HubException(400,message);return n.longValue();}
}
