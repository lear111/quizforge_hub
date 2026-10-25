package cloud.treenewbee.quizforge.hub.admin;

import jakarta.servlet.http.*;
import java.io.*;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.delivery.RequestLimit;

@RestController
public class AdminController {
    private final AdminAccess access;private final AdminService service;private final PackModerationService moderation;private final PracticeAdminClient bridge;private final AccountHttp http;private final SessionIdentity identity;private final AuthPolicy policy;private final RequestLimit limits;private final Path work;
    private static final String ID="[a-f0-9-]{36}";
    public AdminController(AdminAccess access,AdminService service,PackModerationService moderation,PracticeAdminClient bridge,AccountHttp http,SessionIdentity identity,AuthPolicy policy,RequestLimit limits,HubProperties properties){this.access=access;this.service=service;this.moderation=moderation;this.bridge=bridge;this.http=http;this.identity=identity;this.policy=policy;this.limits=limits;work=properties.dataDir().resolve("admin-work");}
    @RequestMapping("/api/admin/{*path}") public Object admin(@PathVariable String path,HttpServletRequest request,HttpServletResponse response)throws Exception{
        var actor=access.require(request);String method=request.getMethod(),token=identity.token(request);if(!method.equals("GET"))http.sameOrigin(request);String route=path.startsWith("/")?path:"/"+path;
        if(method.equals("GET")){
            if(route.equals("/contact"))return service.contact();
            if(route.equals("/invitations"))return service.invitations();
            if(route.equals("/overview"))return service.overview(page(request.getParameter("days")),token);
            if(route.equals("/users"))return service.users(Objects.requireNonNullElse(request.getParameter("q"),""),page(request.getParameter("page")),token);
            if(route.matches("/users/"+ID+"/profile"))return service.profile(route.split("/")[2]);
            if(route.equals("/packs"))return moderation.list(Objects.requireNonNullElse(request.getParameter("status"),"pending"),page(request.getParameter("page")));
            if(route.equals("/reports"))return service.reports();
            if(route.equals("/audit"))return service.audit(token);
        }
        if(route.startsWith("/cloud/")){Object result=cloud(route.substring(7),method,request,actor,token);if(method.equals("POST")&&(route.equals("/cloud/submissions")||route.matches("/cloud/users/"+ID+"/import")))response.setStatus(201);return result;}
        if(method.equals("POST")&&route.equals("/invitations")){limits.check(request,"admin-invite-create",10,actor.get("id").toString());response.setStatus(201);return service.createInvitations(http.body(request),actor.get("id"));}
        if(method.equals("POST")&&route.matches("/invitations/"+ID+"/revoke"))return service.revokeInvitation(route.split("/")[2],actor.get("id"));
        if(method.equals("PUT")&&route.equals("/contact"))return service.contact(http.body(request),actor.get("id"));
        if(method.equals("PUT")&&route.equals("/invitations/settings")){var input=http.body(request);if(input.size()!=1||!(input.get("invitationRequired") instanceof Boolean))throw new HubException(400,"请明确选择是否启用邀请码验证");policy.set(input,actor.get("id"));return Map.of("invitationRequired",input.get("invitationRequired"));}
        if(method.equals("PUT")&&route.matches("/users/"+ID+"/block"))return service.block(route.split("/")[2],http.body(request),actor.get("id"));
        if(method.equals("POST")&&route.matches("/packs/"+ID+"/(inspect|decision|unpublish)")){String id=route.split("/")[2],action=route.split("/")[3];limits.check(request,"admin-pack-"+action,30,actor.get("id").toString());return switch(action){case "inspect"->moderation.inspect(id,actor.get("id"),token);case "decision"->moderation.decision(id,http.body(request),actor.get("id"),token);default->moderation.unpublish(id,http.body(request),actor.get("id"));};}
        throw new HubException(404,"管理接口不存在");
    }
    private Object cloud(String route,String method,HttpServletRequest request,Map<String,Object> actor,String token)throws Exception{
        String query=request.getQueryString();String remote="/"+route+(query==null?"":"?"+query);
        boolean allowed=method.equals("GET")&&(route.matches("submissions(?:/"+ID+"(?:/file)?)?")||route.equals("extensions")||route.equals("extensions/affected"))||method.equals("POST")&&(route.equals("submissions")||route.matches("submissions/"+ID+"/decision")||route.matches("users/"+ID+"/import")||route.equals("extensions/revoke"))||method.equals("PUT")&&(route.equals("defaults")||route.matches("users/"+ID+"/limits"));
        if(!allowed)throw new HubException(404,"管理接口不存在");
        Object result;
        if(method.equals("POST")&&(route.equals("submissions")||route.endsWith("/import"))){
            limits.check(request,"admin-package-upload",6,actor.get("id").toString());String filename;try{filename=URLDecoder.decode(Objects.requireNonNullElse(request.getHeader("X-QuizForge-Filename"),""),StandardCharsets.UTF_8);}catch(IllegalArgumentException error){throw new HubException(400,"文件名无效");}
            if(filename.isEmpty()||filename.length()>240||filename.matches("(?s).*[\\\\/\\x00-\\x1f].*"))throw new HubException(400,"文件名无效");
            if(!"application/octet-stream".equals(request.getContentType()))throw new HubException(415,"请使用二进制文件上传");
            if(request.getContentLengthLong()>64L*1048576)throw new HubException(413,"审核包超过 64 MiB");
            Files.createDirectories(work);if(Files.isSymbolicLink(work))throw new HubException(503,"临时目录不可用");Path file=Files.createTempFile(work,"submission-",".bin");
            try{long size=0;try(var in=request.getInputStream();var out=Files.newOutputStream(file)){byte[] buffer=new byte[32768];for(int count;(count=in.read(buffer))!=-1;){size+=count;if(size>64L*1048576)throw new HubException(413,"审核包超过 64 MiB");out.write(buffer,0,count);}}if(size==0)throw new HubException(400,"文件不能为空");result=bridge.call(remote,method,null,file,filename,Map.of("kind","preaudit"),token);}finally{Files.deleteIfExists(file);}
        }else result=method.equals("GET")?bridge.call(remote,token):bridge.call(remote,method,http.body(request),null,null,null,token);
        if(route.equals("extensions/affected")){var map=(Map<String,Object>)result;map.put("publicPacks",moderation.affected(Objects.requireNonNullElse(request.getParameter("digest"),"")));}
        if(method.equals("POST")&&route.equals("extensions/revoke"))moderation.revokeAffected(actor.get("id"),bridge.call("/extensions",token));
        return result;
    }
    @PostMapping({"/api/activity","/internal/activity"}) public Object activity(HttpServletRequest request){
        http.sameOrigin(request);if(request.getRequestURI().startsWith("/internal/"))internal(request);var user=identity.require(request);limits.check(request,"activity",40,user.get("id").toString());var input=http.body(request);return service.activity(user.get("id"),String.valueOf(input.get("kind")));
    }
    public static void internal(HttpServletRequest request){if(!Set.of("127.0.0.1","::1","0:0:0:0:0:0:0:1").contains(request.getRemoteAddr())||!Objects.equals(request.getHeader("Host"),"127.0.0.1:"+request.getLocalPort()))throw new HubException(403,"仅允许服务内部访问");}
    static int page(String raw){try{return Math.max(1,Math.min(100000,Integer.parseInt(raw)));}catch(Exception error){return 1;}}
}
