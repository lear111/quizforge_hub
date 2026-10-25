package cloud.treenewbee.quizforge.hub.catalog;

import jakarta.servlet.http.*;
import java.io.IOException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.delivery.*;

@RestController
public class PackDetailController {
    private final CatalogService catalog;private final PackArchiveService archives;private final PackFeedbackService feedback;private final SessionIdentity identity;private final AccountHttp http;private final RequestLimit limits;private final FileDelivery delivery;
    public PackDetailController(CatalogService catalog,PackArchiveService archives,PackFeedbackService feedback,SessionIdentity identity,AccountHttp http,RequestLimit limits,FileDelivery delivery){this.catalog=catalog;this.archives=archives;this.feedback=feedback;this.identity=identity;this.http=http;this.limits=limits;this.delivery=delivery;}
    @GetMapping("/api/packs/{id:"+CatalogService.ID+"}/catalog") public Object contents(@PathVariable String id,HttpServletRequest request){var file=catalog.file(id,identity.current(request));limits.check(request,"pack-catalog",60);return archives.catalog(file);}
    @PostMapping("/api/packs/{id:"+CatalogService.ID+"}/download-selection") public void selected(@PathVariable String id,HttpServletRequest request,HttpServletResponse response)throws IOException{
        http.sameOrigin(request);var user=identity.current(request);var file=catalog.file(id,user);limits.check(request,"download-selection",10);var input=http.body(request);
        try(var prepared=archives.selection(file,input)){delivery.selection(request,response,file,user,prepared);}
    }
    @PostMapping("/api/packs/{id:"+CatalogService.ID+"}/comments") public ResponseEntity<?> comment(@PathVariable String id,HttpServletRequest request){http.sameOrigin(request);var user=identity.require(request);limits.check(request,"comment",10,user.get("id").toString());return ResponseEntity.status(201).body(feedback.comment(id,user,http.body(request)));}
    @PostMapping("/api/packs/{id:"+CatalogService.ID+"}/report") public ResponseEntity<?> report(@PathVariable String id,HttpServletRequest request){http.sameOrigin(request);var user=identity.require(request);limits.check(request,"report",5,user.get("id").toString());return ResponseEntity.status(201).body(feedback.report(id,user,http.body(request)));}
    @DeleteMapping("/api/comments/{id:"+CatalogService.ID+"}") public Object delete(@PathVariable String id,HttpServletRequest request){http.sameOrigin(request);var user=identity.require(request);limits.check(request,"comment-delete",30,user.get("id").toString());return feedback.delete(id,user);}
}
