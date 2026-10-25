package cloud.treenewbee.quizforge.hub.account;

import java.util.*;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.delivery.RequestLimit;

@RestController
public class DeviceController {
    private final DeviceService devices;private final SessionIdentity identity;private final AccountHttp http;private final RequestLimit limits;private final cloud.treenewbee.quizforge.hub.ai.AiPoints points;
    public DeviceController(DeviceService devices,SessionIdentity identity,AccountHttp http,RequestLimit limits,cloud.treenewbee.quizforge.hub.ai.AiPoints points){this.devices=devices;this.identity=identity;this.http=http;this.limits=limits;this.points=points;}
    @GetMapping("/connect/authorize") public ResponseEntity<?> consent(HttpServletRequest request){
        try {limits.check(request,"connect-authorize",30);var consent=devices.authorize(request.getParameterMap());var user=identity.current(request);if(user==null)return ResponseEntity.status(303).header("Location","/manage/#connect-login/"+consent.key()).build();return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(devices.page(consent,user));}
        catch(DeviceException error){return ResponseEntity.status(error.status).contentType(MediaType.TEXT_HTML).body("<!doctype html><meta charset=\"UTF-8\"><title>连接请求无效</title><p>"+DeviceService.escape(error.getMessage())+"</p>");}
    }
    @PostMapping("/api/connect/authorize") public Object decision(HttpServletRequest request){http.sameOrigin(request);devices.requireEnabled();var user=identity.require(request);limits.check(request,"connect-decision",20,user.get("id").toString());return devices.decision(http.body(request),user.get("id"));}
    @PostMapping("/api/connect/token") public Object exchange(HttpServletRequest request){devices.requireEnabled();limits.check(request,"connect-token",20);return devices.exchange(http.body(request));}
    @GetMapping("/api/connect/me") public Object me(HttpServletRequest request){return devices.me(request.getHeader("Authorization"));}
    @PostMapping("/api/connect/logout") public ResponseEntity<?> logout(HttpServletRequest request){devices.logout(request.getHeader("Authorization"));return ResponseEntity.noContent().build();}
    @PostMapping("/api/connect/redeem") public Object redeem(HttpServletRequest request){var device=devices.device(request.getHeader("Authorization"));limits.check(request,"ai-redeem",10,device.get("user_id").toString());return points.redeem(device.get("user_id"),http.body(request).get("code"));}
    @GetMapping("/api/connect/devices") public Object list(HttpServletRequest request){devices.requireEnabled();return devices.list(identity.require(request).get("id"));}
    @RequestMapping(value="/api/connect/devices/{id}",method={RequestMethod.PUT,RequestMethod.DELETE}) public Object change(HttpServletRequest request,@PathVariable String id){http.sameOrigin(request);devices.requireEnabled();var user=identity.require(request);limits.check(request,"connect-devices",30,user.get("id").toString());boolean revoke=request.getMethod().equals("DELETE");return devices.change(user.get("id"),id,revoke?null:http.body(request).get("name"),revoke);}
    @RestControllerAdvice(assignableTypes=DeviceController.class) @Order(Ordered.HIGHEST_PRECEDENCE)
    public static class Errors {
        @ExceptionHandler(DeviceException.class) public ResponseEntity<?> known(DeviceException error){return ResponseEntity.status(error.status).body(Map.of("error",Map.of("code",error.code,"message",error.getMessage())));}
        @ExceptionHandler(HubException.class) public ResponseEntity<?> common(HubException error){return ResponseEntity.status(error.status()).body(Map.of("error",Map.of("code","CONNECT_REQUEST_REJECTED","message",error.getMessage())));}
    }
}
