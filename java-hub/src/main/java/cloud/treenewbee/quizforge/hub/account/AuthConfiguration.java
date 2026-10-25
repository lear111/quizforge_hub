package cloud.treenewbee.quizforge.hub.account;
import java.time.Clock;
import org.springframework.context.annotation.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
@Configuration
public class AuthConfiguration {
    @Bean @ConditionalOnMissingBean public Clock accountClock() { return Clock.systemUTC(); }
}
