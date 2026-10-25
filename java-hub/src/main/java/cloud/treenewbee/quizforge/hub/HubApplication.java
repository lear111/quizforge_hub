package cloud.treenewbee.quizforge.hub;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import cloud.treenewbee.quizforge.hub.config.HubProperties;

@SpringBootApplication
@EnableConfigurationProperties(HubProperties.class)
public class HubApplication {
    public static void main(String[] args) { SpringApplication.run(HubApplication.class, args); }
}
