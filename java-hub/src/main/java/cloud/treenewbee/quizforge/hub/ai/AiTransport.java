package cloud.treenewbee.quizforge.hub.ai;

import java.io.ByteArrayOutputStream;
import java.net.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.Flow;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
public class AiTransport {
    public record Result(int status,Map<String,Object> body){}
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build();
    private final JsonMapper json=JsonMapper.builder().build();
    public Result call(String base,String key,Map<String,Object> body,int timeoutSeconds){
        if(AiUpstreams.url(base)==null)throw new IllegalArgumentException("Invalid AI upstream");
        var request=HttpRequest.newBuilder(URI.create(base+"/chat/completions")).timeout(Duration.ofSeconds(timeoutSeconds)).header("Content-Type","application/json").header("Accept","application/json").header("Authorization","Bearer "+key).POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
        var future=client.sendAsync(request,ignored->new BoundedBody());
        try{var response=future.get(timeoutSeconds,TimeUnit.SECONDS);var tree=json.readTree(response.body());return new Result(response.statusCode(),tree.isObject()?json.convertValue(tree,Map.class):Map.of());}
        catch(InterruptedException error){Thread.currentThread().interrupt();throw new IllegalStateException("AiRequestInterrupted");}catch(Exception error){throw new IllegalStateException("AiRequestFailed");}finally{if(!future.isDone())future.cancel(true);}
    }
    private static class BoundedBody implements HttpResponse.BodySubscriber<byte[]> {
        private final CompletableFuture<byte[]> result=new CompletableFuture<>();private final ByteArrayOutputStream bytes=new ByteArrayOutputStream();private Flow.Subscription subscription;
        public CompletionStage<byte[]> getBody(){return result;}
        public void onSubscribe(Flow.Subscription value){subscription=value;value.request(1);}
        public void onNext(List<ByteBuffer> chunks){for(var chunk:chunks){if(chunk.remaining()>8*1048576-bytes.size()){subscription.cancel();result.completeExceptionally(new IllegalStateException("AiResponseTooLarge"));return;}byte[] data=new byte[chunk.remaining()];chunk.get(data);bytes.writeBytes(data);}subscription.request(1);}
        public void onError(Throwable error){result.completeExceptionally(error);}public void onComplete(){result.complete(bytes.toByteArray());}
    }
}
