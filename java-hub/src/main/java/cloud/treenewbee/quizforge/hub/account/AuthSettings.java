package cloud.treenewbee.quizforge.hub.account;

import java.net.URI;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

@Component
public class AuthSettings {
    private final Environment environment;
    public AuthSettings(Environment environment) {
        this.environment=environment;
        String origin=value("PUBLIC_ORIGIN");
        if(!origin.isEmpty()) {
            URI uri=URI.create(origin);
            boolean loopback=uri.getHost()!=null && (uri.getHost().equals("127.0.0.1")||uri.getHost().equals("localhost"));
            if(uri.getHost()==null || !(uri.getScheme().equals("https") || uri.getScheme().equals("http") && loopback) || uri.getRawUserInfo()!=null || !uri.getRawPath().isEmpty() || uri.getRawQuery()!=null || uri.getRawFragment()!=null)
                throw new IllegalArgumentException("PUBLIC_ORIGIN must be an HTTPS origin or local loopback HTTP origin");
        }
    }
    public String value(String name) { return environment.getProperty(name,""); }
    public String value(String name,String fallback) { String value=value(name); return value.isEmpty()?fallback:value; }
    public boolean enabled(String name) { String value=value(name); return value.equals("1")||value.equals("true"); }
    public int integer(String name,int fallback,int min,int max) {
        String raw=value(name); if(raw.isEmpty()) return fallback;
        try { int value=Integer.parseInt(raw); if(value<min||value>max) throw new NumberFormatException(); return value; }
        catch(NumberFormatException e) { throw new IllegalArgumentException("Invalid "+name); }
    }
}
