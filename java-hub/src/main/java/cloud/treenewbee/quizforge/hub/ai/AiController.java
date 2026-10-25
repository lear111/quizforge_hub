package cloud.treenewbee.quizforge.hub.ai;

import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.admin.*;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.delivery.RequestLimit;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@RestController
public class AiController {
    private final AiGateway gateway;private final AiUpstreams upstreams;private final AiPoints points;private final DeviceService devices;private final SessionIdentity identity;private final AccountHttp http;private final AdminAccess access;private final RequestLimit limits;private final HubDatabase db;private final AccountCrypto passwords;
    public AiController(AiGateway gateway,AiUpstreams upstreams,AiPoints points,DeviceService devices,SessionIdentity identity,AccountHttp http,AdminAccess access,RequestLimit limits,HubDatabase db,AccountCrypto passwords){this.gateway=gateway;this.upstreams=upstreams;this.points=points;this.devices=devices;this.identity=identity;this.http=http;this.access=access;this.limits=limits;this.db=db;this.passwords=passwords;}
    @PostMapping("/api/ai/v1/chat/completions") public Object completion(HttpServletRequest request){gateway.requireEnabled();var device=devices.device(request.getHeader("Authorization"));return gateway.complete(request,device.get("user_id"));}
    @RequestMapping("/internal/ai/{*path}") public Object internal(@PathVariable String path,HttpServletRequest request){AdminController.internal(request);gateway.requireEnabled();var user=identity.current(request);if(user==null)throw new DeviceException(401,"HUB_LOGIN_REQUIRED","登录已失效，请重新登录 Hub");if(!request.getMethod().equals("GET"))http.sameOrigin(request);return switch(path){case "/me"->{if(!request.getMethod().equals("GET"))throw new DeviceException(405,"AI_REQUEST_UNSUPPORTED","只支持 GET");var profile=new LinkedHashMap<String,Object>();for(String field:List.of("name","email","phone"))if(user.containsKey(field))profile.put(field,user.get(field));yield Map.of("user",profile,"ai",upstreams.usage(user.get("id")));}case "/redeem"->{if(!request.getMethod().equals("POST"))throw new DeviceException(405,"AI_REQUEST_UNSUPPORTED","只支持 POST");limits.check(request,"ai-redeem",10,user.get("id").toString());yield points.redeem(user.get("id"),http.body(request).get("code"));}case "/chat/completions"->{if(!request.getMethod().equals("POST"))throw new DeviceException(405,"AI_REQUEST_UNSUPPORTED","只支持 POST");yield gateway.complete(request,user.get("id"));}default->throw new DeviceException(404,"AI_REQUEST_UNSUPPORTED","接口不存在");};}
    @GetMapping("/api/account/ai") public Object account(HttpServletRequest request){return points.account(identity.require(request).get("id"));}
    @PostMapping("/api/account/ai/redeem") public Object redeem(HttpServletRequest request){http.sameOrigin(request);var user=identity.require(request);limits.check(request,"ai-redeem",10,user.get("id").toString());return points.redeem(user.get("id"),http.body(request).get("code"));}
    @RequestMapping({"/api/admin/official-ai","/api/admin/ai-keys","/api/admin/ai-keys/{*tail}","/api/admin/ai-codes","/api/admin/ai-codes/{id}","/api/admin/users/{id}/ai-balance"}) public Object admin(HttpServletRequest request,HttpServletResponse response){
        var actor=access.require(request);String method=request.getMethod(),route=request.getRequestURI().substring("/api/admin".length());Object id=actor.get("id");if(!method.equals("GET"))http.sameOrigin(request);
        if(route.equals("/official-ai")){if(method.equals("GET"))return upstreams.adminStatus();if(method.equals("PUT"))return upstreams.switchService(http.body(request),id);}
        if(route.equals("/ai-codes")){if(method.equals("GET"))return points.codes();if(method.equals("POST")){limits.check(request,"admin-ai-codes",10,id.toString());response.setStatus(201);return points.create(http.body(request),id);}}
        if(route.matches("/ai-codes/[a-f0-9-]{36}")&&method.equals("PUT"))return points.updateCode(route.split("/")[2],http.body(request),id);
        if(route.matches("/users/[a-f0-9-]{36}/ai-balance")){String user=route.split("/")[2];if(method.equals("GET"))return points.account(user);if(method.equals("PUT")){limits.check(request,"admin-ai-balance",30,id.toString());return points.set(user,http.body(request),id);}}
        if(route.equals("/ai-keys")&&method.equals("POST")){limits.check(request,"admin-ai-key",10,id.toString());var input=new LinkedHashMap<String,Object>(http.body(request));Object plain=input.remove("password");String hash=db.read(c->row(c,"SELECT password FROM users WHERE id=?",id).get("password").toString());if(!(plain instanceof String password)||!passwords.matches(password,hash))throw new HubException(403,"管理员密码不正确，API Key 未添加");response.setStatus(201);return upstreams.add(input,id);}
        if(route.equals("/ai-keys/order")&&method.equals("PUT"))return upstreams.reorder(http.body(request),id);
        if(route.matches("/ai-keys/[a-f0-9-]{36}(/(test|enabled))?")){String key=route.split("/")[2];if(route.endsWith("/test")&&method.equals("POST")){limits.check(request,"admin-ai-key-test",20,id.toString());return upstreams.test(key,id);}if(route.endsWith("/enabled")&&method.equals("PUT"))return upstreams.enabledKey(key,http.body(request),id);if(route.split("/").length==3){if(method.equals("PUT"))return upstreams.updateKey(key,http.body(request),id);if(method.equals("DELETE"))return upstreams.remove(key,id);}}
        throw new HubException(404,"管理接口不存在");
    }
    @RestControllerAdvice(assignableTypes=AiController.class) @Order(Ordered.HIGHEST_PRECEDENCE)
    public static class Errors {
        @ExceptionHandler(DeviceException.class) public ResponseEntity<?> known(DeviceException error){return ResponseEntity.status(error.status).body(Map.of("error",Map.of("code",error.code,"message",error.getMessage())));}
        @ExceptionHandler(HubException.class) public ResponseEntity<?> common(HubException error){return ResponseEntity.status(error.status()).body(Map.of("error",Map.of("code","AI_REQUEST_REJECTED","message",error.getMessage())));}
    }
}
