package cloud.treenewbee.quizforge.hub.catalog;

import java.sql.*;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import cloud.treenewbee.quizforge.hub.account.AccountStore;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class PackFeedbackService {
    private final HubDatabase database;
    public PackFeedbackService(HubDatabase database){this.database=database;}
    private static String text(Map<String,Object> input,String field,int limit,String label){
        if(!(input.get(field) instanceof String value))throw new HubException(400,"请填写"+label);
        value=value.replaceAll("^[\\s\\p{Z}\\uFEFF]+|[\\s\\p{Z}\\uFEFF]+$","");
        if(value.isEmpty()||value.length()>limit)throw new HubException(400,label+"须为1–"+limit+"个字符");return value;
    }
    private static void active(Connection c,Object id)throws SQLException{if(AccountStore.blocked(c,id)||row(c,"SELECT id FROM users WHERE id=?",id)==null)throw new HubException(401,"请重新登录");}
    private static void writable(Connection c,String pack,Map<String,Object> user)throws SQLException{
        active(c,user.get("id"));if(!"approved".equals(CatalogService.readable(c,pack,user).get("status")))throw new HubException(409,"题库通过审核后才能评论或举报");
    }
    public Map<String,Object> comment(String pack,Map<String,Object> user,Map<String,Object> input){
        String body=text(input,"body",2000,"评论");return database.transaction(c->{writable(c,pack,user);String id=UUID.randomUUID().toString(),created=Instant.now().toString();update(c,"INSERT INTO comments VALUES(?,?,?,?,?)",id,pack,user.get("id"),body,created);return Map.of("comment",Map.of("id",id,"user_id",user.get("id"),"author",user.get("name"),"body",body,"created",created));});
    }
    public Map<String,Object> report(String pack,Map<String,Object> user,Map<String,Object> input){
        String reason=text(input,"reason",1000,"举报原因");return database.transaction(c->{writable(c,pack,user);update(c,"INSERT INTO reports VALUES(?,?,?,?,?)",UUID.randomUUID().toString(),pack,user.get("id"),reason,Instant.now().toString());return Map.of("ok",true);});
    }
    public Map<String,Object> delete(String id,Map<String,Object> user){return database.transaction(c->{active(c,user.get("id"));var comment=row(c,"SELECT * FROM comments WHERE id=?",id);if(comment==null)throw new HubException(404,"评论不存在");var current=row(c,"SELECT admin FROM users WHERE id=?",user.get("id"));if(!Objects.equals(comment.get("user_id"),user.get("id"))&&number(current.get("admin"))!=1)throw new HubException(403,"仅作者或管理员可删除评论");update(c,"DELETE FROM comments WHERE id=?",id);return Map.of("ok",true);});}
}
