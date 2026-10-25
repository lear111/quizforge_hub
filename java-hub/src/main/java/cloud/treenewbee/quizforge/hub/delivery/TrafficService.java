package cloud.treenewbee.quizforge.hub.delivery;

import java.sql.*;
import java.time.*;
import java.util.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.SessionIdentity;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class TrafficService {
    private final HubDatabase database;
    private final HubProperties config;
    private final JsonMapper json = JsonMapper.builder().build();
    public TrafficService(HubDatabase database, HubProperties config) { this.database = database; this.config = config; }
    public void reserve(HttpServletRequest request, long bytes, boolean reserve, Map<String,Object> user, String downloadedPack) {
        if (bytes < 0) throw new HubException(503, "文件大小无效");
        Instant now = Instant.now();
        String month = YearMonth.from(now.atZone(ZoneId.of(config.timeZone()))).toString();
        String ip = config.trustProxy() && request.getHeader("X-Real-IP") != null ? request.getHeader("X-Real-IP") : request.getRemoteAddr();
        String day = now.atZone(ZoneOffset.UTC).toLocalDate() + ":" + SessionIdentity.hash(ip);
        database.transaction(c -> {
            if (bytes > config.monthlyBudgetBytes() - usage(c, month)) throw new HubException(429, "本月附件下载预算已用完，请下月再来或联系管理员");
            if (bytes > config.ipDailyBudgetBytes() - usage(c, day)) throw new HubException(429, "今天的附件下载额度已用完，请明天再来");
            if (reserve) {
                if (user != null && config.cloudEnabled()) account(c, String.valueOf(user.get("id")), bytes, now);
                for (String period : List.of(month, day)) update(c, "INSERT INTO traffic VALUES (?,?) ON CONFLICT(period) DO UPDATE SET bytes=bytes+excluded.bytes", period, bytes);
                if (downloadedPack != null) update(c, "UPDATE packs SET downloads=downloads+1 WHERE id=?", downloadedPack);
                update(c,"INSERT INTO activity_transfers VALUES(?,1,?) ON CONFLICT(day) DO UPDATE SET requests=requests+1,bytes=bytes+excluded.bytes",now.atZone(ZoneId.of("Asia/Shanghai")).toLocalDate().toString(),bytes);
            }
            return null;
        });
    }
    private long usage(Connection c, String period) throws SQLException { var row = row(c, "SELECT bytes FROM traffic WHERE period=?", period); return row == null ? 0 : number(row.get("bytes")); }
    private void account(Connection c, String id, long bytes, Instant now) throws SQLException {
        // Preserve daily account limits when opening a snapshot with cloud accounts.
        if (row(c, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_defaults'") == null) return;
        var defaultsRow = row(c, "SELECT value FROM cloud_defaults WHERE id=1");
        if (defaultsRow == null) throw new HubException(503, "账号配额暂不可用");
        update(c, "INSERT OR IGNORE INTO cloud_accounts(user_id,limits_json) VALUES (?,?)", id, "{\"storageBytes\":null,\"dailyTrafficBytes\":null,\"monthlyTrafficBytes\":null}");
        var account = row(c, "SELECT limits_json FROM cloud_accounts WHERE user_id=?", id);
        var defaults = json.readValue(String.valueOf(defaultsRow.get("value")), Map.class);
        var overrides = json.readValue(String.valueOf(account.get("limits_json")), Map.class);
        Object daily = overrides.get("dailyTrafficBytes") == null ? defaults.get("dailyTrafficBytes") : overrides.get("dailyTrafficBytes");
        if (!(daily instanceof Number)) throw new HubException(503, "账号配额暂不可用");
        String day = now.atZone(ZoneId.of(config.timeZone())).toLocalDate().toString(), month = day.substring(0, 7);
        var previous = row(c, "SELECT bytes FROM cloud_traffic WHERE user_id=? AND period=?", id, day);
        if (bytes > number(daily) - (previous == null ? 0 : number(previous.get("bytes")))) throw new HubException(429, "今日下载流量额度已用完，请明天再试或联系管理员");
        for (String period : List.of(month, day)) update(c, "INSERT INTO cloud_traffic VALUES (?,?,?) ON CONFLICT(user_id,period) DO UPDATE SET bytes=bytes+excluded.bytes", id, period, bytes);
    }
}
