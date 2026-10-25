package cloud.treenewbee.quizforge.hub.delivery;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.number;

@Service
public class FileDelivery {
    private final HubProperties config;
    private final TrafficService traffic;
    private final RequestLimit limits;
    private final JsonMapper json = JsonMapper.builder().build();
    public FileDelivery(HubProperties config, TrafficService traffic, RequestLimit limits) { this.config = config; this.traffic = traffic; this.limits = limits; }
    private Path file(String folder, String name, long size) {
        try {
            Path expected = config.dataDir().toRealPath().resolve(folder);
            if (Files.isSymbolicLink(expected)) throw new HubException(404, "文件不存在或已更新");
            Path directory = expected.toRealPath(), file = directory.resolve(name);
            if (Files.isSymbolicLink(file) || !file.toRealPath().getParent().equals(directory) || !Files.isRegularFile(file) || Files.size(file) != size)
                throw new HubException(404, "文件不存在或已更新");
            return file;
        } catch (IOException error) { throw new HubException(404, "文件不存在或已更新"); }
    }
    public void available(HttpServletRequest request, Map<String,Object> item) {
        file("files", String.valueOf(item.get("id")), number(item.get("size")));
        traffic.reserve(request, number(item.get("size")), false, null, null);
    }
    public Path archivePath(Map<String,Object> item) { return file("files",String.valueOf(item.get("id")),number(item.get("size"))); }
    public void selection(HttpServletRequest request,HttpServletResponse response,Map<String,Object> original,Map<String,Object> user,cloud.treenewbee.quizforge.hub.catalog.PackArchiveService.Prepared prepared)throws IOException {
        try(var input=Files.newInputStream(prepared.file)){
            traffic.reserve(request,prepared.size,true,user,String.valueOf(original.get("pack_id")));
            response.setContentType("application/vnd.quizforge.qbank");response.setContentLengthLong(prepared.size);
            response.setHeader("Content-Disposition","attachment; filename=\"selected.qbank\"; filename*=UTF-8''"+URLEncoder.encode(prepared.name,StandardCharsets.UTF_8).replace("+","%20"));
            response.setHeader("Cache-Control","private, no-store");input.transferTo(response.getOutputStream());
        }
    }
    public ResponseEntity<?> archive(HttpServletRequest request, Map<String,Object> item, Map<String,Object> user) {
        long size = number(item.get("size")); String name = String.valueOf(item.get("name"));
        Path file = file("files", String.valueOf(item.get("id")), size);
        limits.check(request, "download", 30);
        traffic.reserve(request, size, true, user, String.valueOf(item.get("pack_id")));
        String suffix = name.contains(".") ? name.substring(name.lastIndexOf('.')) : "";
        if (!suffix.matches("\\.[A-Za-z0-9]{1,8}")) suffix = "";
        String disposition = "attachment; filename=\"question-bank" + suffix + "\"; filename*=UTF-8''" + URLEncoder.encode(name, StandardCharsets.UTF_8).replace("+", "%20");
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).contentLength(size).header("Content-Disposition", disposition)
                .header("Cache-Control", "private, no-store").body(new FileSystemResource(file));
    }
    public ResponseEntity<?> image(HttpServletRequest request, Map<String,Object> item, Map<String,Object> user) {
        long size = number(item.get("size")); String mime = String.valueOf(item.get("mime"));
        if (!List.of("image/png", "image/jpeg", "image/webp").contains(mime)) throw new HubException(404, "图片不存在");
        Path file = file("files", String.valueOf(item.get("id")), size);
        limits.check(request, "image", 180); traffic.reserve(request, size, true, user, null);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(mime)).contentLength(size).header("Cache-Control", "private, no-store").body(new FileSystemResource(file));
    }
    @SuppressWarnings("unchecked")
    public List<Map<String,Object>> installers() {
        Path manifest = config.dataDir().resolve("downloads/manifest.json");
        if (!Files.exists(manifest)) return List.of();
        try {
            if (Files.isSymbolicLink(manifest) || Files.isSymbolicLink(manifest.getParent())) throw new HubException(503, "安装包清单暂不可用");
            if (Files.size(manifest) > 65536) throw new HubException(503, "安装包清单暂不可用");
            var value = json.readValue(Files.readString(manifest), Map.class);
            if (!(value.get("items") instanceof List<?> items)) return List.of();
            var accepted = new ArrayList<Map<String,Object>>();
            for (var raw : items) if (raw instanceof Map<?,?> entry && ("windows".equals(entry.get("platform")) || "android".equals(entry.get("platform")))
                    && entry.get("file") instanceof String name && name.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,120}")
                    && entry.get("bytes") instanceof Number bytes && bytes.longValue() >= 0 && bytes.longValue() <= 9007199254740991L && bytes.doubleValue() == bytes.longValue()) accepted.add((Map<String,Object>)entry);
            return accepted;
        } catch (IOException error) { throw new HubException(503, "安装包清单暂不可用"); }
    }
    public ResponseEntity<?> installer(HttpServletRequest request, String name) {
        var item = installers().stream().filter(row -> Objects.equals(name, row.get("file"))).findFirst().orElseThrow(() -> new HubException(404, "安装包不存在或已更新，请刷新下载页"));
        long size = number(item.get("bytes")); Path file = file("downloads", name, size);
        if (request.getMethod().equals("GET")) traffic.reserve(request, size, true, null, null);
        String mime = item.get("platform").equals("android") ? "application/vnd.android.package-archive" : "application/vnd.microsoft.portable-executable";
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(mime)).contentLength(size).header("Cache-Control", "no-cache")
                .header("Content-Disposition", "attachment; filename=\"" + name + "\"").body(request.getMethod().equals("HEAD") ? null : new FileSystemResource(file));
    }
}
