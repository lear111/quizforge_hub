package cloud.treenewbee.quizforge.hub.account;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Service;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class SessionIdentity {
    private final HubDatabase database;
    private final Pattern cookie;
    public SessionIdentity(HubDatabase database, HubProperties properties) {
        this.database = database;
        cookie = Pattern.compile("(?:^|;\\s*)" + Pattern.quote(properties.cookieName()) + "=([a-f0-9]{64})(?:;|$)");
    }
    public static String hash(String raw) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    public Map<String,Object> current(HttpServletRequest request) {
        String header = request.getHeader("Cookie"); if (header == null) return null;
        var match = cookie.matcher(header); if (!match.find()) return null;
        return database.read(connection -> current(connection, hash(match.group(1))));
    }
    public String token(HttpServletRequest request) { String header=request.getHeader("Cookie");if(header==null)return null;var match=cookie.matcher(header);return match.find()?match.group(1):null; }
    private Map<String,Object> current(Connection c, String token) throws SQLException {
        var user = row(c, "SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=u.id)", token, System.currentTimeMillis());
        if (user == null) return null;
        return AccountStore.profile(c,user.get("id"));
    }
    public Map<String,Object> require(HttpServletRequest request) { var user = current(request); if (user == null) throw new HubException(401, "请先登录"); return user; }
    public Map<String,Object> admin(HttpServletRequest request) { var user=require(request);if(number(user.get("admin"))==0)throw new HubException(403,"仅管理员可管理此设置");return user; }
}
