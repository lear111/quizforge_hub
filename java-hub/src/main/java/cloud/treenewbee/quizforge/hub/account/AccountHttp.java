package cloud.treenewbee.quizforge.hub.account;

import java.io.IOException;
import java.net.URI;
import java.util.*;
import jakarta.servlet.http.*;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;

@Component
public class AccountHttp {
    private final AuthSettings settings;
    private final HubProperties hub;
    private final JsonMapper json=JsonMapper.builder().enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build();
    public AccountHttp(AuthSettings settings,HubProperties hub) { this.settings=settings;this.hub=hub; }
    public String ip(HttpServletRequest request) { return hub.trustProxy() && request.getHeader("X-Real-IP")!=null?request.getHeader("X-Real-IP"):request.getRemoteAddr(); }
    public String origin(HttpServletRequest request) {
        String configured=settings.value("PUBLIC_ORIGIN"); if(!configured.isEmpty()) return configured;
        String name=request.getServerName();
        if(!Set.of("localhost","127.0.0.1","::1","[::1]").contains(name)) throw new HubException(503,"请先配置此服务的 PUBLIC_ORIGIN");
        return request.getScheme()+"://"+request.getHeader("Host");
    }
    public String hostname(HttpServletRequest request) { return URI.create(origin(request)).getHost(); }
    public void sameOrigin(HttpServletRequest request) {
        if(!Objects.equals(request.getHeader("Origin"),origin(request))) throw new HubException(403,"请求来源不受信任");
        if("cross-site".equals(request.getHeader("Sec-Fetch-Site"))) throw new HubException(403,"请求来源不受信任");
    }
    @SuppressWarnings("unchecked") public Map<String,Object> body(HttpServletRequest request) {
        String type=request.getContentType(); if(type==null||!type.toLowerCase(Locale.ROOT).matches("application/json(?:;.*)?")) throw new HubException(415,"请使用 JSON 请求");
        if(request.getContentLengthLong()>24000) throw new HubException(413,"上传内容超过大小限制");
        try {
            byte[] bytes=request.getInputStream().readNBytes(24001); if(bytes.length>24000) throw new HubException(413,"上传内容超过大小限制");
            Object value=json.readValue(bytes,Object.class);
            if(!(value instanceof Map<?,?> map)) throw new HubException(400,"请求内容应为对象"); return (Map<String,Object>)map;
        } catch(IOException|tools.jackson.core.JacksonException e) { throw new HubException(400,"请求内容格式错误"); }
    }
    public void cookie(HttpServletResponse response,String token,int maxAge) { response.setHeader("Set-Cookie",hub.cookieName()+"="+token+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+maxAge+(settings.enabled("COOKIE_SECURE")?"; Secure":"")); }
    public static String text(Map<String,Object> input,String field,int min,int max,String label) {
        if(!(input.get(field) instanceof String value) || value.strip().codePointCount(0,value.strip().length())<min || value.strip().codePointCount(0,value.strip().length())>max) throw new HubException(400,label+"长度不正确"); return value.strip();
    }
    public static String password(Map<String,Object> input) {
        if(!(input.get("password") instanceof String value)||value.length()<10||value.length()>128) throw new HubException(400,"密码至少需要 10 个字符，且不超过 128 个字符"); return value;
    }
}
