package cloud.treenewbee.quizforge.hub.admin;

import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.Semaphore;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.AuthSettings;
import cloud.treenewbee.quizforge.hub.common.HubException;

/** Fixed loopback protocol to the retained practice service, never a caller-selected URL. */
@Service
public class PracticeAdminClient {
    private final AuthSettings settings;private final int port;private final Semaphore slots=new Semaphore(4);
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final JsonMapper json=JsonMapper.builder().build();
    public PracticeAdminClient(AuthSettings settings){this.settings=settings;port=settings.integer("PRACTICE_ADMIN_PORT",4324,1,65535);}
    public boolean enabled(){return settings.enabled("PRACTICE_BRIDGE_ENABLED");}
    public Map<String,Object> call(String route,String token){return call(route,"GET",null,null,null,null,token);}
    public Map<String,Object> send(String route,Map<String,Object> body,String token){return call(route,"POST",body,null,null,null,token);}
    public Map<String,Object> call(String route,String method,Map<String,Object> body,Path file,String filename,Map<String,Object> source,String token){
        if(!enabled())throw new HubException(503,"练习服务管理连接尚未配置");
        if(!route.matches("/[a-zA-Z0-9/?=&%.,_+~-]*")||route.length()>8192||route.contains("..")||route.startsWith("//")||token==null||!token.matches("[a-f0-9]{64}"))throw new HubException(400,"管理服务请求无效");
        if(!slots.tryAcquire())throw new HubException(503,"管理服务正在处理其他请求，请稍后重试");
        try{
            var request=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+"/internal/admin"+route)).timeout(Duration.ofSeconds(180)).header("Cookie","qfh_session="+token).header("Accept","application/json");
            HttpRequest.BodyPublisher publisher=HttpRequest.BodyPublishers.noBody();
            if(file!=null){if(Files.size(file)>64L*1048576)throw new HubException(413,"审核包不能超过 64 MiB");publisher=HttpRequest.BodyPublishers.ofFile(file);request.header("Content-Type","application/octet-stream").header("X-QuizForge-Filename",encode(filename));if(source!=null)request.header("X-QFH-Source",encode(json.writeValueAsString(source)));}
            else if(body!=null){publisher=HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body),StandardCharsets.UTF_8);request.header("Content-Type","application/json");}
            var response=client.send(request.method(method,publisher).build(),HttpResponse.BodyHandlers.ofInputStream());
            try(var input=response.body()){
                byte[] bytes=input.readNBytes(12*1048576+1);if(bytes.length>12*1048576||response.statusCode()>=300&&response.statusCode()<400)throw new IOException("Invalid practice response");
                var tree=json.readTree(bytes);if(!tree.isObject())throw new IOException("Invalid practice response");
                if(response.statusCode()<200||response.statusCode()>=300){String message=tree.path("error").isString()?tree.path("error").asText():"练习管理请求未完成";throw new HubException(response.statusCode()>=400&&response.statusCode()<=599?response.statusCode():503,message.length()<=1000?message:"练习管理请求未完成");}
                return json.convertValue(tree,Map.class);
            }
        }catch(HubException error){throw error;}catch(InterruptedException error){Thread.currentThread().interrupt();throw new HubException(503,"管理请求已中断，请先检查保存结果");}catch(Exception error){throw new HubException(503,"练习管理服务暂时不可用，请先检查操作结果");}finally{slots.release();}
    }
    public static String encode(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20");}
}
