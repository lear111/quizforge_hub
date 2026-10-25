package cloud.treenewbee.quizforge.hub.catalog;

import java.sql.*;
import java.util.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import cloud.treenewbee.quizforge.hub.common.HubException;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class CatalogService {
    public static final String ID = "[a-f0-9-]{36}";
    private final HubDatabase database;
    private final JsonMapper json = JsonMapper.builder().build();
    public CatalogService(HubDatabase database) { this.database = database; }
    public Map<String,Object> list(String query, String sort, String pageText, Map<String,Object> owner) {
        return list(query,sort,pageText,owner,"");
    }
    public Map<String,Object> list(String query, String sort, String pageText, Map<String,Object> owner,String status) {
        final String q = (query == null ? "" : query.trim());
        final String term = q.substring(0, Math.min(100, q.length()));
        final int page = page(pageText);
        return database.read(c -> {
            var args = new ArrayList<Object>();
            String where = owner == null ? " WHERE p.status='approved'" : " WHERE p.user_id=?";
            if (owner != null) args.add(owner.get("id"));
            if(owner!=null&&!status.isEmpty()){
                if(!Set.of("pending","approved","rejected").contains(status))throw new HubException(400,"审核状态无效");
                where+=" AND p.status=?";args.add(status);
            }
            if (!term.isEmpty()) {
                where += " AND (p.title LIKE ? ESCAPE '!' OR p.summary LIKE ? ESCAPE '!' OR p.tags LIKE ? ESCAPE '!')";
                String pattern = "%" + term.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
                args.add(pattern); args.add(pattern); args.add(pattern);
            }
            long count = number(row(c, "SELECT COUNT(*) AS n FROM packs p" + where, args.toArray()).get("n"));
            String order = "popular".equals(sort) ? "p.downloads DESC,p.updated DESC" : "p.updated DESC";
            args.add((page - 1) * 12);
            var packs = rows(c, "SELECT p.*,u.name AS author FROM packs p JOIN users u ON u.id=p.user_id" + where + " ORDER BY " + order + " LIMIT 12 OFFSET ?", args.toArray());
            for (var pack : packs) enrich(c, pack);
            return Map.of("packs", packs, "count", count, "page", page);
        });
    }
    static int page(String raw) {
        if (raw == null) return 1;
        var match = java.util.regex.Pattern.compile("^\\s*([+-]?\\d+)").matcher(raw);
        if (!match.find()) return 1;
        try { return (int)Math.max(1, Math.min(100000, Long.parseLong(match.group(1)))); }
        catch (NumberFormatException ignored) { return raw.stripLeading().startsWith("-") ? 1 : 100000; }
    }
    public Map<String,Object> detail(String id, Map<String,Object> viewer) {
        return database.read(c -> {
            var pack = readable(c, id, viewer); enrich(c, pack);
            var comments = rows(c, "SELECT c.id,c.user_id,c.body,c.created,u.name AS author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.pack_id=? ORDER BY c.created DESC LIMIT 100", id);
            return Map.of("pack", pack, "comments", comments);
        });
    }
    public Map<String,Object> file(String packId, Map<String,Object> viewer) {
        return database.read(c -> {
            var pack = readable(c, packId, viewer);
            var file = row(c, "SELECT * FROM files WHERE pack_id=? AND kind='archive' ORDER BY rowid LIMIT 1", packId);
            if (file == null) throw new HubException(404, "压缩包不存在"); file.put("pack_revision",pack.get("revision")); return file;
        });
    }
    public Map<String,Object> image(String id, Map<String,Object> viewer) {
        return database.read(c -> {
            var file = row(c, "SELECT * FROM files WHERE id=? AND kind='image'", id);
            if (file == null) throw new HubException(404, "图片不存在");
            readable(c, String.valueOf(file.get("pack_id")), viewer); return file;
        });
    }
    public static Map<String,Object> readable(Connection c, String id, Map<String,Object> viewer) throws SQLException {
        var pack = row(c, "SELECT p.*,u.name AS author FROM packs p JOIN users u ON u.id=p.user_id WHERE p.id=?", id);
        if (pack == null) throw new HubException(404, "题库不存在或已下架");
        if (!"approved".equals(pack.get("status")) && (viewer == null || (!Objects.equals(pack.get("user_id"), viewer.get("id")) && number(viewer.get("admin")) == 0)))
            throw new HubException(404, "题库不存在或尚未通过审核");
        return pack;
    }
    private void enrich(Connection c, Map<String,Object> pack) throws SQLException {
        pack.put("tags", json.readValue(String.valueOf(pack.get("tags")), List.class));
        var files = rows(c, "SELECT id,kind,name,mime,size,sha256 FROM files WHERE pack_id=? ORDER BY rowid", pack.get("id"));
        files.stream().filter(file -> "archive".equals(file.get("kind"))).findFirst().ifPresent(file -> pack.put("archive", file));
        pack.put("screenshots", files.stream().filter(file -> "image".equals(file.get("kind"))).toList());
        pack.put("commentCount", number(row(c, "SELECT COUNT(*) AS n FROM comments WHERE pack_id=?", pack.get("id")).get("n")));
    }
}
