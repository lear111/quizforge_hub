package cloud.treenewbee.quizforge.hub.catalog;

import jakarta.servlet.http.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.delivery.RequestLimit;
import cloud.treenewbee.quizforge.hub.admin.PackModerationService;
import java.util.*;

@RestController
public class PackPublishingController {
    private final PackPublishingService publishing;private final SessionIdentity identity;private final AccountHttp http;private final RequestLimit limits;private final PackModerationService moderation;private final CatalogService catalog;
    public PackPublishingController(PackPublishingService publishing,SessionIdentity identity,AccountHttp http,RequestLimit limits,PackModerationService moderation,CatalogService catalog){this.publishing=publishing;this.identity=identity;this.http=http;this.limits=limits;this.moderation=moderation;this.catalog=catalog;}
    @PostMapping("/api/packs") public ResponseEntity<?> create(HttpServletRequest request)throws Exception{return save(null,request);}
    @PutMapping("/api/packs/{id:"+CatalogService.ID+"}") public ResponseEntity<?> edit(@PathVariable String id,HttpServletRequest request)throws Exception{return save(id,request);}
    @DeleteMapping("/api/packs/{id:"+CatalogService.ID+"}") public Object delete(@PathVariable String id,HttpServletRequest request){http.sameOrigin(request);var user=identity.require(request);limits.check(request,"pack-delete",20,user.get("id").toString());Object revision=request.getContentType()==null?null:http.body(request).get("revision");return publishing.delete(id,user,revision);}
    @PostMapping("/api/packs/{id:"+CatalogService.ID+"}/publish") public Object publish(@PathVariable String id,HttpServletRequest request){
        http.sameOrigin(request);var user=identity.admin(request);limits.check(request,"admin-upload-publish",30,user.get("id").toString());var input=http.body(request);
        if(input.keySet().stream().anyMatch(key->!Set.of("revision","codeReviewed").contains(key))||input.containsKey("codeReviewed")&&!(input.get("codeReviewed") instanceof Boolean))throw new HubException(400,"发布参数无效");
        long revision=cloud.treenewbee.quizforge.hub.admin.AdminAccess.integer(input.get("revision"),1,9007199254740991L,"题库版本无效");
        return publishSaved(id,revision,Boolean.TRUE.equals(input.get("codeReviewed")),user,request,false);
    }
    private Object publishSaved(String id,long revision,boolean codeReviewed,Map<String,Object> user,HttpServletRequest request,boolean saved){
        Object state;
        try{state=moderation.publishOwnUpload(id,revision,codeReviewed,user.get("id"),identity.token(request));}
        catch(HubException error){if(!saved)throw error;state=Map.of("state","not-published","message",error.getMessage());}
        var result=new LinkedHashMap<String,Object>(catalog.detail(id,user));result.put("publication",state);return result;
    }
    private ResponseEntity<?> save(String id,HttpServletRequest request)throws Exception {
        // Lazy multipart resolution keeps these checks ahead of multipart disk parsing.
        http.sameOrigin(request);var user=identity.require(request);String owner=user.get("id").toString();publishing.preflight(id,owner);limits.check(request,"publishing",6,owner);
        String type=request.getContentType();if(type==null||!type.toLowerCase(java.util.Locale.ROOT).startsWith("multipart/form-data;"))throw new HubException(415,"请使用文件上传表单");
        java.util.Collection<Part> parts;
        try{parts=request.getParts();}
        catch(org.apache.tomcat.util.http.InvalidParameterException error){int status=error.getErrorCode()==413?413:400;throw new HubException(status,status==413?"上传文件过大；题库最多 20 MB，每张截图最多 3 MB":"上传表单项目过多或格式无效");}
        catch(IllegalStateException error){throw new HubException(413,"上传文件过大；题库最多 20 MB，每张截图最多 3 MB");}
        catch(jakarta.servlet.ServletException error){throw new HubException(400,"上传表单无效或未完整传输，请重新选择文件");}
        try{
            var result=publishing.save(id,user,parts);var administrator=(Map<?,?>)result.remove("adminUpload");
            if(administrator!=null){var pack=(Map<?,?>)result.get("pack");return ResponseEntity.status(id==null?201:200).body(publishSaved(pack.get("id").toString(),((Number)pack.get("revision")).longValue(),Boolean.TRUE.equals(administrator.get("codeReviewed")),user,request,true));}
            return ResponseEntity.status(id==null?201:200).body(result);
        }
        finally{for(var part:parts)try{part.delete();}catch(java.io.IOException ignored){}}
    }
}
