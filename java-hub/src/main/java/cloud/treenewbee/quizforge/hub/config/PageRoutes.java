package cloud.treenewbee.quizforge.hub.config;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class PageRoutes {
    @GetMapping("/download") public String downloads() { return "redirect:/#download"; }
    @GetMapping({"/manage","/manage/","/manage/index.html"}) public String loginPage(){return "forward:/index.html";}
}
