package cloud.treenewbee.quizforge.hub.ai;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class AiGateway {
    private final AiUpstreams upstreams;private final AiPoints points;private final AiTransport transport;private final HubDatabase db;private final Clock clock;private final Semaphore site;
    private final Map<String,Integer> active=new HashMap<>();private final JsonMapper json=JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build();
    private static final Pattern IMAGE=Pattern.compile("data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})");
    public AiGateway(AiUpstreams upstreams,AiPoints points,AiTransport transport,HubDatabase db,Clock clock,AuthSettings settings){this.upstreams=upstreams;this.points=points;this.transport=transport;this.db=db;this.clock=clock;site=new Semaphore(settings.integer("AI_SITE_CONCURRENCY",2,1,8));}
    private static DeviceException invalid(String message){return new DeviceException(400,"AI_REQUEST_UNSUPPORTED",message);}
    public void requireEnabled(){if(!upstreams.enabled())throw new DeviceException(404,"OFFICIAL_AI_DISABLED","免费 AI 暂未开放");}
    @SuppressWarnings("unchecked") public static Map<String,Object> validate(Map<String,Object> body){
        if(body.keySet().stream().anyMatch(k->!Set.of("model","messages","max_tokens","response_format","temperature","stream").contains(k))||body.containsKey("stream")&&!Boolean.FALSE.equals(body.get("stream")))throw invalid("不支持的请求字段或流式输出");
        if(!"quizforge-official".equals(body.get("model")))throw invalid("model 必须为 quizforge-official");
        if(!(body.get("messages") instanceof List<?> messages)||messages.isEmpty()||messages.size()>50)throw invalid("messages 必须是 1–50 条消息");long images=0;
        for(Object raw:messages){if(!(raw instanceof Map<?,?> message)||message.keySet().stream().anyMatch(k->!Set.of("role","content").contains(k))||(!(message.get("role") instanceof String role)||!Set.of("system","user","assistant").contains(role)))throw invalid("消息格式不正确");Object content=message.get("content");if(content instanceof String)continue;if(!(content instanceof List<?> parts)||parts.isEmpty())throw invalid("消息内容格式不正确");
            for(Object item:parts){if(!(item instanceof Map<?,?> part))throw invalid("消息内容格式不正确");if("text".equals(part.get("type"))&&part.get("text") instanceof String&&part.size()==2)continue;if(!"image_url".equals(part.get("type"))||part.size()!=2||!(part.get("image_url") instanceof Map<?,?> image)||image.keySet().stream().anyMatch(k->!Set.of("url","detail").contains(k))||!(image.get("url") instanceof String url))throw invalid("图片只接受 PNG、JPEG、WebP 的 data URL");var match=IMAGE.matcher(url);if(!match.matches())throw invalid("图片只接受 PNG、JPEG、WebP 的 data URL");String data=match.group(1);long bytes=data.length()*3L/4-(data.endsWith("==")?2:data.endsWith("=")?1:0);if(bytes>4L*1048576)throw new DeviceException(413,"AI_REQUEST_TOO_LARGE","单张图片不能超过 4 MiB");images+=bytes;
            }
        }
        if(images>12L*1048576)throw new DeviceException(413,"AI_REQUEST_TOO_LARGE","一次请求的图片总大小不能超过 12 MiB");
        if(body.containsKey("max_tokens")&&(!(body.get("max_tokens") instanceof Number n)||n.doubleValue()!=n.longValue()||n.longValue()<1||n.longValue()>8192))throw invalid("max_tokens 必须是 1–8192 的整数");
        if(body.containsKey("temperature")&&(!(body.get("temperature") instanceof Number n)||!Double.isFinite(n.doubleValue())||n.doubleValue()<0||n.doubleValue()>2))throw invalid("temperature 必须在 0–2 之间");
        if(body.containsKey("response_format")&&(!(body.get("response_format") instanceof Map<?,?> format)||(!(format.get("type") instanceof String type)||!Set.of("json_object","json_schema","text").contains(type))))throw invalid("response_format 不受支持");
        var request=new LinkedHashMap<>(body);request.remove("model");request.remove("stream");request.putIfAbsent("max_tokens",8192);return request;
    }
    public Object complete(HttpServletRequest request,Object user){
        requireEnabled();if(!site.tryAcquire())throw new DeviceException(429,"AI_BUSY","免费 AI 评分人数较多，请稍后重试");boolean entered=false;
        try{
            synchronized(active){int count=active.getOrDefault(user.toString(),0);if(count>=2)throw new DeviceException(429,"AI_BUSY","同时进行的评分太多，请等前面的评分完成后再试");active.put(user.toString(),count+1);entered=true;}
            String type=request.getContentType();if(type==null||!type.toLowerCase(Locale.ROOT).matches("application/json(?:;.*)?"))throw new DeviceException(415,"AI_REQUEST_UNSUPPORTED","请使用 JSON 请求");
            Map<String,Object> input;
            try{if(request.getContentLengthLong()>13L*1048576)throw new DeviceException(413,"AI_REQUEST_TOO_LARGE","请求超过 12 MiB 上限");byte[] raw=request.getInputStream().readNBytes(13*1048576+1);if(raw.length>13*1048576)throw new DeviceException(413,"AI_REQUEST_TOO_LARGE","请求超过 12 MiB 上限");var tree=json.readTree(raw);if(!tree.isObject())throw invalid("请求内容应为对象");input=json.convertValue(tree,Map.class);}catch(DeviceException error){throw error;}catch(Exception error){throw invalid("请求内容不是有效的 JSON");}
            var body=validate(input);if(points.balance(user)<1)throw new DeviceException(402,"AI_BALANCE_EXHAUSTED","免费 AI 额度已用完，可以输入兑换码获取额度，或改用自己的模型。");var candidates=upstreams.candidates();if(candidates.isEmpty())throw new DeviceException(503,"AI_DISABLED","免费 AI 暂时不可用，请稍后重试，或改用自己的模型");
            AiTransport.Result answer=null;AiUpstreams.Candidate used=null;int tried=0,throttled=0;
            for(var upstream:candidates.subList(0,Math.min(3,candidates.size()))){var outgoing=new LinkedHashMap<String,Object>(body);outgoing.put("model",upstream.model);AiUpstreams.Failure failure;
                try{var result=transport.call(upstream.baseUrl,upstream.key,outgoing,90);if(result.status()>=200&&result.status()<300&&result.body().get("choices") instanceof List<?> choices&&!choices.isEmpty()){answer=result;used=upstream;break;}failure=AiUpstreams.failure(result.status(),result.body());}catch(RuntimeException error){failure=new AiUpstreams.Failure("fault","无法连接或等待超时");}
                tried++;if(failure.status().equals("throttled"))throttled++;upstreams.failed(upstream.id,failure);
            }
            if(answer==null)throw new DeviceException(throttled==tried?429:502,throttled==tried?"AI_BUSY":"AI_UPSTREAM_FAILED",throttled==tried?"免费 AI 当前请求较多，请稍后重试，本次不扣额度":"免费 AI 模型暂时没有响应，本次不扣额度");
            var selected=used;var response=answer.body();var usage=response.get("usage") instanceof Map<?,?> m?m:Map.of();long cost=AiUpstreams.cost(usage,selected.inputPrice,selected.outputPrice),tokens=AiUpstreams.count(usage.get("total_tokens"));
            var accounting=db.transaction(c->{if(AccountStore.blocked(c,user))throw new DeviceException(401,"HUB_LOGIN_REQUIRED","账号已停用，本次不扣额度");long balance=AiPoints.balance(c,user),spent=Math.min(cost,balance),now=clock.millis();if(spent>0)update(c,"UPDATE ai_points SET balance=MAX(balance-?,0),updated=? WHERE user_id=?",spent,now,user);update(c,"UPDATE ai_upstreams SET status='ok',reason=NULL,status_at=?,cooldown_until=0,spent=spent+?,remaining=CASE WHEN remaining IS NULL THEN NULL ELSE MAX(remaining-?,0) END,input_tokens=input_tokens+?,output_tokens=output_tokens+?,calls=calls+1 WHERE id=?",now,cost,cost,AiUpstreams.count(usage.get("prompt_tokens")),AiUpstreams.count(usage.get("completion_tokens")),selected.id);update(c,"INSERT INTO official_ai_usage VALUES(?,?,1,?,?) ON CONFLICT(user_id,day) DO UPDATE SET calls=calls+1,tokens=tokens+excluded.tokens,points=points+excluded.points",user,AiUpstreams.LocalDay.today(clock),tokens,spent);return Map.of("cost",spent,"balance",AiPoints.balance(c,user));});
            var result=new LinkedHashMap<String,Object>();result.put("id","qf-"+UUID.randomUUID());result.put("object","chat.completion");result.put("model","quizforge-official");result.put("choices",response.get("choices"));if(response.containsKey("usage"))result.put("usage",response.get("usage"));result.put("quizforge",accounting);return result;
        }finally{if(entered)synchronized(active){int count=active.getOrDefault(user.toString(),1)-1;if(count==0)active.remove(user.toString());else active.put(user.toString(),count);}site.release();}
    }
}
