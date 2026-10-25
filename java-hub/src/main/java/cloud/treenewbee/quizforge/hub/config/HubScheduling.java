package cloud.treenewbee.quizforge.hub.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

@Configuration
@EnableScheduling
@ConditionalOnProperty(name="hub.maintenance",havingValue="false",matchIfMissing=true)
public class HubScheduling {}
