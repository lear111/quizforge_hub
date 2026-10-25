package cloud.treenewbee.quizforge.hub.admin;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.common.HubException;

@Controller
public class AdminPages {
    private final SessionIdentity identity;private final AuthSettings settings;
    public AdminPages(SessionIdentity identity,AuthSettings settings){this.identity=identity;this.settings=settings;}
    @GetMapping({"/admin","/admin/","/admin/index.html"}) public org.springframework.web.servlet.View page(HttpServletRequest request){if(!settings.enabled("ADMIN_ENABLED"))throw new HubException(404,"管理后台尚未开放");var user=identity.current(request);if(user==null){var redirect=new org.springframework.web.servlet.view.RedirectView("/manage/#admin",true);redirect.setStatusCode(org.springframework.http.HttpStatus.SEE_OTHER);return redirect;}if(((Number)user.get("admin")).intValue()==0)throw new HubException(403,"仅管理员可访问");return new org.springframework.web.servlet.view.InternalResourceView("/admin/shell.html");}
}
