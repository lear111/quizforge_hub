package cloud.treenewbee.quizforge.hub.catalog;

import java.util.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.account.SessionIdentity;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.delivery.FileDelivery;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;

@RestController
public class PublicHubController {
    private final CatalogService catalog;
    private final SessionIdentity identity;
    private final FileDelivery files;
    private final HubDatabase database;
    private final HubProperties config;
    private final LocalImportService imports;
    private final cloud.treenewbee.quizforge.hub.account.AuthSettings settings;
    public PublicHubController(CatalogService catalog, SessionIdentity identity, FileDelivery files, HubDatabase database, HubProperties config,LocalImportService imports,cloud.treenewbee.quizforge.hub.account.AuthSettings settings) {
        this.catalog = catalog; this.identity = identity; this.files = files; this.database = database; this.config = config;this.imports=imports;this.settings=settings;
    }
    @GetMapping("/api/health") public Object health() { return Map.of("ok", true, "runtime", "java", "phase", "hub-feature-parity"); }
    @GetMapping("/api/me") public Object me(HttpServletRequest request) { var value = new LinkedHashMap<String,Object>(); value.put("user", identity.current(request)); return value; }
    @GetMapping("/api/packs") public Object list(HttpServletRequest request, @RequestParam(defaultValue="") String q, @RequestParam(defaultValue="") String sort,
            @RequestParam(defaultValue="1") String page, @RequestParam(defaultValue="0") String mine,@RequestParam(defaultValue="") String status) {
        return catalog.list(q, sort, page, mine.equals("1") ? identity.require(request) : null,status);
    }
    @GetMapping("/api/packs/{id:" + CatalogService.ID + "}") public Object detail(HttpServletRequest request, @PathVariable String id) { return catalog.detail(id, identity.current(request)); }
    @RequestMapping(value="/api/packs/{id:" + CatalogService.ID + "}/download", method=RequestMethod.GET)
    public Object archive(HttpServletRequest request, @PathVariable String id) {
        if(request.getParameterMap().containsKey("revision")||request.getParameterMap().containsKey("sha256"))return imports.serve(id,request,true);
        if (!request.getMethod().equals("GET")) throw new HubException(404, "页面不存在");
        var user = identity.current(request); return files.archive(request, catalog.file(id, user), user);
    }
    @RequestMapping("/api/packs/{id:"+CatalogService.ID+"}/local-import") public Object manifest(HttpServletRequest request,@PathVariable String id){return imports.serve(id,request,false);}
    @GetMapping("/api/packs/{id:" + CatalogService.ID + "}/download-status") public Object available(HttpServletRequest request, @PathVariable String id) {
        files.available(request, catalog.file(id, identity.current(request))); return Map.of("ok", true);
    }
    @GetMapping("/media/{id:" + CatalogService.ID + "}") public ResponseEntity<?> image(HttpServletRequest request, @PathVariable String id) {
        if (!request.getMethod().equals("GET")) throw new HubException(404, "页面不存在");
        var user = identity.current(request); return files.image(request, catalog.image(id, user), user);
    }
    @GetMapping("/api/admin-contact") public Object contact() {
        return database.read(c -> {
            var contact = HubDatabase.row(c, "SELECT content,revision FROM admin_contact WHERE id=1");
            if (contact == null || !(contact.get("content") instanceof String text) || text.length() > 4000 || !(contact.get("revision") instanceof Number revision) || revision.doubleValue() != revision.longValue() || revision.longValue() < 0 || revision.longValue() > 9007199254740991L)
                throw new HubException(503, "管理员联系方式暂时不可用，请稍后重试");
            return contact;
        });
    }
    @GetMapping("/api/downloads") public Object downloads() { return Map.of("items", files.installers()); }
    @RequestMapping(value="/download/files/{name}", method={RequestMethod.GET, RequestMethod.HEAD})
    public ResponseEntity<?> installer(HttpServletRequest request, @PathVariable String name) { return files.installer(request, name); }
    @GetMapping("/api/java/capabilities") public Object capabilities() {
        return Map.of("phase", "hub-feature-parity", "practiceOrigin", config.practiceOrigin(), "legacyOrigin", config.legacyOrigin(), "localImportEnabled", config.localImportEnabled()&&!settings.value("HUB_LOCAL_CLIENT_IMPORT_ENABLED","true").equals("false")&&!settings.value("HUB_LOCAL_CLIENT_IMPORT_ENABLED").equals("0"),
                "native", List.of("catalog", "search", "detail", "session-read", "auth-write", "verification", "contact-binding", "devices", "attachments", "traffic", "installers", "admin-contact", "package-catalog", "selected-bank-export", "comments-write", "reports-write", "publishing", "publishing-edit", "publishing-delete", "review", "admin-management", "review-notifications", "ai-balance", "ai-gateway", "practice-internal-api", "cloud-import", "local-import"),
                "pending", List.of("production-cutover", "real-provider-acceptance", "browser-device-acceptance"));
    }
}
