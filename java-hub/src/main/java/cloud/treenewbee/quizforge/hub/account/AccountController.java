package cloud.treenewbee.quizforge.hub.account;

import java.util.*;
import jakarta.servlet.http.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.delivery.RequestLimit;
import cloud.treenewbee.quizforge.hub.common.HubException;

@RestController
public class AccountController {
    private final AccountService accounts;private final AccountHttp http;private final RequestLimit limits;private final SessionIdentity identity;private final AuthPolicy policy;private final AuthSettings settings;
    public AccountController(AccountService accounts,AccountHttp http,RequestLimit limits,SessionIdentity identity,AuthPolicy policy,AuthSettings settings) {this.accounts=accounts;this.http=http;this.limits=limits;this.identity=identity;this.policy=policy;this.settings=settings;}
    @GetMapping("/api/config") public Object config() {return accounts.config();}
    @PostMapping({"/api/auth/register","/api/auth/login"}) public ResponseEntity<?> authenticate(HttpServletRequest request,HttpServletResponse response) {
        http.sameOrigin(request);limits.check(request,"auth",12);var input=http.body(request);boolean register=request.getRequestURI().endsWith("register");
        var result=register?accounts.register(input,request):accounts.login(input,request);http.cookie(response,result.token(),30*86400);return ResponseEntity.status(register?201:200).body(Map.of("user",result.user()));
    }
    @PostMapping({"/api/auth/email-code","/api/auth/phone-code","/api/auth/login-code"}) public Object code(HttpServletRequest request) {
        http.sameOrigin(request);String kind=request.getRequestURI().substring(request.getRequestURI().lastIndexOf('/')+1);limits.check(request,kind,6);var input=http.body(request);
        if(kind.equals("login-code")){limits.check(request,"auth",12);accounts.loginCode(input,request);}else accounts.registrationCode(input,request,kind.startsWith("email")?"email":"phone");
        return Map.of("message",kind.startsWith("email")?"如果该邮箱可以注册，验证码将发送到邮箱，请检查收件箱和垃圾邮件。":kind.startsWith("phone")?"如果该手机号可以注册，验证码将通过短信发送，请注意查收。":"验证码已发送，请查收。","retryAfter",60);
    }
    @PostMapping("/api/auth/logout") public Object logout(HttpServletRequest request,HttpServletResponse response) {http.sameOrigin(request);accounts.logout(identity.token(request));http.cookie(response,"",0);return Map.of("ok",true);}
    @PostMapping({"/api/account/contact-code","/api/account/contact"}) public Object bind(HttpServletRequest request) {http.sameOrigin(request);var user=identity.require(request);limits.check(request,"bind-contact",8,user.get("id").toString());return accounts.bind(http.body(request),request,user.get("id"),request.getRequestURI().endsWith("contact-code"));}
    @GetMapping("/api/admin/authentication") public Object policy(HttpServletRequest request) {admin(request);return Map.of("policy",policy.get(),"capabilities",policy.capabilities());}
    @PutMapping("/api/admin/authentication") public Object policyUpdate(HttpServletRequest request) {http.sameOrigin(request);var user=admin(request);return policy.set(http.body(request),user.get("id"));}
    private Map<String,Object> admin(HttpServletRequest request) {if(!settings.enabled("ADMIN_ENABLED"))throw new HubException(404,"管理后台尚未开放");var user=identity.admin(request);limits.check(request,"admin",120,user.get("id").toString());return user;}
}
