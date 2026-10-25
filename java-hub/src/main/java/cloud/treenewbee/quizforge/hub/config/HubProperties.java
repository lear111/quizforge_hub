package cloud.treenewbee.quizforge.hub.config;

import java.net.URI;
import java.nio.file.Path;
import java.time.ZoneId;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("hub")
public record HubProperties(Path dataDir, String cookieName, long monthlyBudgetBytes,
        long ipDailyBudgetBytes, String timeZone, boolean trustProxy, boolean cloudEnabled, boolean localImportEnabled, String practiceOrigin, String legacyOrigin) {
    public HubProperties {
        dataDir = dataDir.toAbsolutePath().normalize();
        if (!cookieName.matches("[a-z][a-z0-9_]{0,40}")) throw new IllegalArgumentException("Invalid cookie name");
        if (monthlyBudgetBytes < 0 || ipDailyBudgetBytes < 0) throw new IllegalArgumentException("Invalid traffic limit");
        ZoneId.of(timeZone);
        checkOrigin(practiceOrigin); checkOrigin(legacyOrigin);
    }
    private static void checkOrigin(String value) {
        if (value == null || value.isEmpty()) return;
        URI uri = URI.create(value);
        if (!"https".equals(uri.getScheme()) && !("http".equals(uri.getScheme()) && ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost()))))
            throw new IllegalArgumentException("Origin must use HTTPS or loopback HTTP");
        if (uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !uri.getRawPath().isEmpty())
            throw new IllegalArgumentException("Expected an origin, without path or credentials");
    }
}
