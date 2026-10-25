package cloud.treenewbee.quizforge.hub.catalog;

import jakarta.servlet.http.HttpServletRequest;
import java.io.*;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.springframework.core.io.InputStreamResource;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.delivery.*;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class LocalImportService {
    public static class Failure extends RuntimeException {final int status;final String code;Failure(int status,String code,String message){super(message);this.status=status;this.code="LOCAL_IMPORT_"+code;}}
    private final HubDatabase db;private final HubProperties config;private final FileDelivery files;private final TrafficService traffic;private final RequestLimit limits;
    public LocalImportService(HubDatabase db,HubProperties config,FileDelivery files,TrafficService traffic,RequestLimit limits){this.db=db;this.config=config;this.files=files;this.traffic=traffic;this.limits=limits;}
    private Failure fail(int status,String code,String message){return new Failure(status,code,message);}
    private Map<String,Object> current(String id,long revision,String sha){return db.read(c->{var p=row(c,"SELECT p.id AS pack_id,p.title,p.status,p.revision,f.id,f.name,f.size,f.sha256 FROM packs p LEFT JOIN files f ON f.pack_id=p.id AND f.kind='archive' WHERE p.id=?",id);if(p==null||!"approved".equals(p.get("status"))||p.get("id")==null)throw fail(404,"UNAVAILABLE","题库不存在、尚未公开或附件暂不可用");if(number(p.get("revision"))!=revision||sha!=null&&!sha.equals(p.get("sha256")))throw fail(409,"REVISION_CHANGED","题库版本已变化，请刷新 Hub 后重新点击");if(!p.get("name").toString().toLowerCase(Locale.ROOT).endsWith(".qbank"))throw fail(422,"FORMAT_UNSUPPORTED","此附件不支持直接导入，请使用文件下载");if(number(p.get("size"))>64L*1048576)throw fail(413,"TOO_LARGE","题库文件超过 64 MiB");if(!p.get("id").toString().matches(CatalogService.ID)||number(p.get("size"))<1||!String.valueOf(p.get("sha256")).matches("[a-f0-9]{64}"))throw fail(503,"SERVER_ERROR","题库附件信息无效");return p;});}
    public Object serve(String id,HttpServletRequest request,boolean download){
        if(!config.localImportEnabled())throw fail(404,"DISABLED","Hub 暂未开启直接导入，请下载 .qbank 文件");if(!request.getMethod().equals("GET"))throw fail(405,"REQUEST_INVALID","此接口只支持 GET");
        try{limits.check(request,download?"download":"local-import-manifest",download?30:60);}catch(HubException error){throw fail(error.status(),"RATE_LIMITED",error.getMessage());}
        var allowed=download?Set.of("revision","sha256"):Set.of("revision");String rev=request.getParameter("revision"),sha=request.getParameter("sha256");
        if(!id.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")||!request.getParameterMap().keySet().equals(allowed)||request.getParameterMap().values().stream().anyMatch(v->v.length!=1)||request.getQueryString()==null||!request.getQueryString().matches("[a-z0-9=&-]+")||rev==null||!rev.matches("[1-9][0-9]{0,15}")||download&&(sha==null||!sha.matches("[a-f0-9]{64}")))throw fail(400,"REQUEST_INVALID","Hub 导入参数无效");
        long revision;try{revision=Long.parseLong(rev);if(revision>9007199254740991L)throw new NumberFormatException();}catch(NumberFormatException error){throw fail(400,"REQUEST_INVALID","Hub 导入参数无效");}
        var first=current(id,revision,sha);InputStream input=null;
        try{Path file=files.archivePath(first);input=Files.newInputStream(file,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS);var fresh=current(id,revision,sha);if(!Objects.equals(first.get("id"),fresh.get("id"))||!Objects.equals(first.get("sha256"),fresh.get("sha256"))||!Objects.equals(first.get("size"),fresh.get("size")))throw fail(409,"REVISION_CHANGED","题库文件已变化，请刷新 Hub 后重新点击");
            if(!download)return Map.of("schemaVersion",1,"pack",Map.of("id",id,"revision",revision,"title",fresh.get("title")),"archive",Map.of("name",fresh.get("name"),"size",fresh.get("size"),"sha256",fresh.get("sha256")));
            try{traffic.reserve(request,number(fresh.get("size")),true,null,id);}catch(HubException error){throw fail(error.status(),"TRAFFIC_LIMIT",error.getMessage());}
            var resource=new InputStreamResource(input);input=null;return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).contentLength(number(fresh.get("size"))).header("Cache-Control","private, no-store").header("Content-Disposition","attachment; filename=\"question-bank.qbank\"; filename*=UTF-8''"+URLEncoder.encode(fresh.get("name").toString(),StandardCharsets.UTF_8).replace("+","%20")).body(resource);
        }catch(Failure error){throw error;}catch(HubException|IOException error){throw fail(404,"UNAVAILABLE","题库附件暂不可用");}finally{if(input!=null)try{input.close();}catch(IOException ignored){}}
    }
    @RestControllerAdvice public static class Errors {@ExceptionHandler(Failure.class) public ResponseEntity<?> known(Failure error){return ResponseEntity.status(error.status).body(Map.of("error",error.getMessage(),"code",error.code));}}
}
