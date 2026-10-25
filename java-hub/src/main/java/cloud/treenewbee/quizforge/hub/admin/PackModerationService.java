package cloud.treenewbee.quizforge.hub.admin;

import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.sql.*;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.catalog.CatalogService;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static cloud.treenewbee.quizforge.hub.admin.AdminAccess.*;

@Service
public class PackModerationService {
    private final HubDatabase db;private final PracticeAdminClient bridge;private final Path files;private final JsonMapper json=JsonMapper.builder().build();
    public PackModerationService(HubDatabase db,PracticeAdminClient bridge,HubProperties properties){this.db=db;this.bridge=bridge;files=properties.dataDir().resolve("files");}
    private Map<String,Object> pack(Connection c,String id)throws SQLException {var p=row(c,"SELECT p.*,u.name AS author,f.id AS file_id,f.name AS filename,f.size,f.sha256 FROM packs p JOIN users u ON u.id=p.user_id LEFT JOIN files f ON f.pack_id=p.id AND f.kind='archive' WHERE p.id=?",id);if(p==null)throw new HubException(404,"题库不存在");return p;}
    private Map<String,Object> pack(String id){return db.read(c->pack(c,id));}
    private void same(Connection c,Map<String,Object> expected)throws SQLException {var fresh=pack(c,expected.get("id").toString());for(String field:List.of("revision","sha256","file_id"))if(!Objects.equals(fresh.get(field),expected.get(field)))throw new HubException(409,"题库已更新，请重新审核");}
    public Object list(String state,int page){if(!Set.of("pending","approved","rejected","all").contains(state))throw new HubException(400,"审核状态无效");return db.read(c->{String where=state.equals("all")?"":" WHERE status=?";Object[] args=state.equals("all")?new Object[]{(page-1)*30}:new Object[]{state,(page-1)*30};var ids=rows(c,"SELECT id FROM packs"+where+" ORDER BY updated DESC LIMIT 30 OFFSET ?",args);var items=new ArrayList<Map<String,Object>>();for(var row:ids){var p=pack(c,row.get("id").toString());p.put("tags",json.readValue(p.get("tags").toString(),List.class));p.put("cloudApproval",row(c,"SELECT * FROM pack_cloud_approvals WHERE pack_id=? AND revision=? AND sha256=?",p.get("id"),p.get("revision"),p.get("sha256")));items.add(p);}long count=number((state.equals("all")?row(c,"SELECT COUNT(*) n FROM packs"):row(c,"SELECT COUNT(*) n FROM packs WHERE status=?",state)).get("n"));return Map.of("items",items,"page",page,"count",count);});}
    private Path verified(Map<String,Object> p){
        String id=String.valueOf(p.get("file_id"));if(!id.matches(CatalogService.ID)||!(p.get("size") instanceof Number size)||size.longValue()<1||size.longValue()>64L*1048576)throw new HubException(422,"题库附件无效");
        try{Path file=files.resolve(id);if(Files.isSymbolicLink(files)||Files.isSymbolicLink(file)||!Files.isRegularFile(file,LinkOption.NOFOLLOW_LINKS)||!file.toRealPath().getParent().equals(files.toRealPath())||Files.size(file)!=size.longValue())throw new IOException();var digest=MessageDigest.getInstance("SHA-256");try(var in=Files.newInputStream(file)){byte[] buffer=new byte[32768];for(int count;(count=in.read(buffer))!=-1;)digest.update(buffer,0,count);}if(!HexFormat.of().formatHex(digest.digest()).equals(p.get("sha256")))throw new HubException(409,"题库文件已变化，请重新上传");return file;}
        catch(HubException error){throw error;}catch(Exception error){throw new HubException(422,"题库附件无法读取");}
    }
    private String prepared(Map<String,Object> p){return db.read(c->{var row=row(c,"SELECT submission FROM pack_admin_reviews WHERE pack_id=? AND revision=? AND sha256=?",p.get("id"),p.get("revision"),p.get("sha256"));return row==null?null:row.get("submission").toString();});}
    private Map<String,Object> item(String id,String token){if(!id.matches(CatalogService.ID))throw new HubException(502,"审核服务返回了无效编号");return (Map<String,Object>)bridge.call("/submissions/"+id,token).get("item");}
    public Object inspect(String id,Object actor,String token){var p=pack(id);if(!String.valueOf(p.get("filename")).toLowerCase(Locale.ROOT).endsWith(".qbank"))return Map.of("pack",p,"notice","此附件不是 .qbank，可审核上架供文件下载，不能导入云端。");
        String prepared=prepared(p);Map<String,Object> item=null;
        if(prepared!=null)try{item=item(prepared,token);}catch(HubException error){if(error.status()!=404)throw error;}
        if(item==null||"rejected".equals(item.get("status"))){Path path=verified(p);item=(Map<String,Object>)bridge.call("/submissions","POST",null,path,p.get("filename").toString(),Map.of("kind","public","packId",id,"revision",p.get("revision"),"sha256",p.get("sha256"),"title",p.get("title")),token).get("item");String submission=String.valueOf(item.get("id"));if(!submission.matches(CatalogService.ID))throw new HubException(502,"审核服务返回了无效编号");db.transaction(c->{current(c,actor);same(c,p);update(c,"INSERT INTO pack_admin_reviews VALUES(?,?,?,?) ON CONFLICT(pack_id,revision,sha256) DO UPDATE SET submission=excluded.submission",id,p.get("revision"),p.get("sha256"),submission);audit(c,actor,"pack-inspected",id,Map.of("revision",p.get("revision"),"sha256",p.get("sha256"),"submission",submission));return null;});}
        return Map.of("pack",p,"item",item);
    }
    public Object decision(String id,Map<String,Object> input,Object actor,String token){
        String note=reason(input),decision=String.valueOf(input.get("decision"));var p=pack(id);if(!Set.of("approved","rejected").contains(decision)||integer(input.get("revision"),1,9007199254740991L,"题库版本无效")!=number(p.get("revision")))throw new HubException(409,"审核决定或题库版本无效，请刷新后重试");
        verified(p);Map<String,Object> item=null;String prepared=prepared(p);boolean qbank=String.valueOf(p.get("filename")).toLowerCase(Locale.ROOT).endsWith(".qbank");
        if(decision.equals("rejected")&&prepared!=null){var job=item(prepared,token);if("pending".equals(job.get("status")))bridge.send("/submissions/"+prepared+"/decision",Map.of("decision","rejected","reason",note),token);}
        if(decision.equals("approved")&&qbank){
            if(prepared==null)throw new HubException(409,"请先查看整包内容与拓展，再执行审核");
            if(!Boolean.TRUE.equals(input.get("codeReviewed")))throw new HubException(400,"请确认已经检查完整拓展代码与资源");
            item=item(prepared,token);
            if("pending".equals(item.get("status")))item=(Map<String,Object>)bridge.send("/submissions/"+prepared+"/decision",Map.of("decision","approved","reason",note,"codeReviewed",true),token).get("item");
            if(!"approved".equals(item.get("status"))||!(item.get("extensions") instanceof List<?> extensions)||extensions.isEmpty()||extensions.stream().anyMatch(raw->!(raw instanceof Map<?,?> e)||!"approved".equals(e.get("status"))))throw new HubException(409,"拓展审核已失效，请重新预审或提交");
        }
        var accepted=item;return db.transaction(c->{current(c,actor);same(c,p);String now=Instant.now().toString();update(c,"UPDATE packs SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?",decision,note,actor,now,id);update(c,"INSERT INTO pack_reviews VALUES(?,?,?,?,?,?,?)",UUID.randomUUID().toString(),id,p.get("revision"),decision,note,actor,now);
            var detail=new LinkedHashMap<String,Object>();detail.put("revision",p.get("revision"));detail.put("sha256",p.get("sha256"));detail.put("reason",note);
            if(accepted!=null){var digests=((List<Map<String,Object>>)accepted.get("extensions")).stream().map(e->e.get("digest")).toList();if(digests.stream().anyMatch(hash->!(hash instanceof String s)||!s.matches("[a-f0-9]{64}")))throw new HubException(502,"拓展审核摘要无效");update(c,"INSERT INTO pack_cloud_approvals VALUES(?,?,?,?,?,?,?) ON CONFLICT(pack_id) DO UPDATE SET revision=excluded.revision,sha256=excluded.sha256,digests=excluded.digests,status=excluded.status,actor_id=excluded.actor_id,created=excluded.created",id,p.get("revision"),p.get("sha256"),json.writeValueAsString(digests),"approved",actor,System.currentTimeMillis());detail.put("digests",digests);}
            else update(c,"UPDATE pack_cloud_approvals SET status='revoked' WHERE pack_id=?",id);
            audit(c,actor,"pack-"+decision,id,detail);return Map.of("ok",true);});
    }
    public Object unpublish(String id,Map<String,Object> input,Object actor){String note=reason(input);return db.transaction(c->{current(c,actor);var p=pack(c,id);update(c,"UPDATE packs SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?",note,actor,Instant.now().toString(),id);update(c,"UPDATE pack_cloud_approvals SET status='revoked' WHERE pack_id=?",id);audit(c,actor,"pack-unpublished",id,Map.of("revision",p.get("revision"),"reason",note));return Map.of("ok",true);});}
    public void revokeAffected(Object actor,Map<String,Object> states){
        var approved=new HashSet<String>();for(Object raw:(List<?>)states.get("entries")){var e=(Map<?,?>)raw;if("approved".equals(e.get("status")))approved.add(String.valueOf(e.get("digest")));}
        db.transaction(c->{current(c,actor);for(var row:rows(c,"SELECT pack_id,digests FROM pack_cloud_approvals WHERE status='approved'")){var digests=json.readValue(row.get("digests").toString(),List.class);if(!approved.containsAll(digests))update(c,"UPDATE pack_cloud_approvals SET status='revoked' WHERE pack_id=?",row.get("pack_id"));}return null;});
    }
    public Object affected(String digest){if(!digest.matches("[a-f0-9]{64}"))throw new HubException(400,"拓展摘要无效");return db.read(c->rows(c,"SELECT a.pack_id AS id,p.title,a.status FROM pack_cloud_approvals a JOIN packs p ON p.id=a.pack_id WHERE EXISTS(SELECT 1 FROM json_each(a.digests) d WHERE d.value=?)",digest));}
}
