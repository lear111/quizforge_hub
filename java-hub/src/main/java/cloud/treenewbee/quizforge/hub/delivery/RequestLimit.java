package cloud.treenewbee.quizforge.hub.delivery;

import java.util.HashMap;
import java.util.Map;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;

@Component
public class RequestLimit {
    private record Entry(long until, int count) {}
    private final Map<String,Entry> entries = new HashMap<>();
    private final HubProperties config;
    public RequestLimit(HubProperties config) { this.config = config; }
    public synchronized void check(HttpServletRequest request, String group, int maximum) {
        check(request,group,maximum,"");
    }
    public synchronized void check(HttpServletRequest request,String group,int maximum,String userId) {
        long now = System.currentTimeMillis();
        entries.entrySet().removeIf(entry -> entry.getValue().until < now);
        String ip = config.trustProxy() && request.getHeader("X-Real-IP") != null ? request.getHeader("X-Real-IP") : request.getRemoteAddr();
        String key = group + ':' + (userId.isEmpty()?ip:userId);
        Entry entry = entries.get(key);
        if (entry == null) { if (entries.size() >= 10000) throw new HubException(503, "服务繁忙，请稍后再试"); entry = new Entry(now + 60000, 0); }
        if (entry.count >= maximum) throw new HubException(429, "操作太频繁，请稍后再试");
        entries.put(key, new Entry(entry.until, entry.count + 1));
    }
}
