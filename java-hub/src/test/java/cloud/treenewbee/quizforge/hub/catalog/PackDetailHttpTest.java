package cloud.treenewbee.quizforge.hub.catalog;

import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.*;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.AccountCrypto;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={"hub.trust-proxy=true","logging.level.root=WARN"})
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class PackDetailHttpTest {
    static final Path DIRECTORY;
    static{try{DIRECTORY=Files.createTempDirectory("qfh-java-pack-detail-");}catch(IOException error){throw new ExceptionInInitializerError(error);}}
    static final JsonMapper JSON=JsonMapper.builder().build();static final AtomicInteger IPS=new AtomicInteger();
    @DynamicPropertySource static void data(DynamicPropertyRegistry registry){registry.add("hub.data-dir",DIRECTORY::toString);}
    @Autowired HubDatabase db;@Autowired HubProperties properties;@Value("${local.server.port}") int port;
    final HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    String owner,other,admin,ownerCookie,otherCookie,adminCookie,ip;
    record Fixture(String id,String archiveId,byte[] bytes,Map<String,byte[]> content){}
    @BeforeEach void seed(){
        owner=account(false);other=account(false);admin=account(true);ownerCookie=cookie(owner);otherCookie=cookie(other);adminCookie=cookie(admin);ip="203.0.113."+IPS.incrementAndGet();
    }
    String origin(){return "http://127.0.0.1:"+port;}
    String account(boolean admin){String id=UUID.randomUUID().toString();db.transaction(c->{update(c,"INSERT INTO users VALUES(?,?,?,?,?,?)",id,id+"@example.test","合成账号","!not-a-login-password",admin?1:0,Instant.now().toString());return null;});return id;}
    String cookie(String user){String raw=AccountCrypto.token();db.transaction(c->{update(c,"INSERT INTO sessions VALUES(?,?,?)",AccountCrypto.sha(raw),user,System.currentTimeMillis()+3600000);return null;});return "qfh_session="+raw;}
    byte[] encode(Object value){return JSON.writeValueAsBytes(value);}
    Map<String,byte[]> content(){
        var result=new LinkedHashMap<String,byte[]>();result.put("quizforge-package.json",encode(Map.of("format","quizforge-bank-group","formatVersion",3,"group","Group")));
        for(String bank:List.of("A","B"))result.put("question-banks/Group/"+bank+"/bank.json",encode(Map.of("id","stable-"+bank,"title","题库"+bank,"extension",Map.of("path","extensions/Group/Choice"),"questions",List.of(Map.of("id","unchanged-question-"+bank,"data",Map.of("answer","unchanged"))))));
        result.put("question-banks/Group/A/assets/test.png",new byte[]{0,1,2,3});result.put("question-banks/Group/B/assets/test.png",new byte[]{4,5,6});
        result.put("extensions/Group/Choice/manifest.json",encode(Map.of("id","stable-extension","version","1.0.0")));
        result.put("extensions/Group/Choice/rules.js","throw new Error('Metadata must never execute this code');".getBytes(StandardCharsets.UTF_8));
        result.put("extensions/Group/Choice/examples/bank.json",encode(Map.of("title","示例不可计入目录","questions",List.of(Map.of(),Map.of()))));return result;
    }
    Fixture pack(Map<String,byte[]> content,String status)throws IOException{
        var output=new ByteArrayOutputStream();try(var zip=new ZipOutputStream(output)){for(var item:content.entrySet()){zip.putNextEntry(new ZipEntry(item.getKey()));zip.write(item.getValue());zip.closeEntry();}}
        byte[] bytes=output.toByteArray();String id=UUID.randomUUID().toString(),file=UUID.randomUUID().toString();Files.write(DIRECTORY.resolve("files").resolve(file),bytes);
        String sha=HexFormat.of().formatHex(AccountCrypto.sha(bytes));db.transaction(c->{update(c,"INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)",id,owner,"合成题库包","合成简介","合成介绍","测试","[]","1.0","2026-10-25","2026-10-25",status);update(c,"INSERT INTO files VALUES(?,?,?,?,?,?,?)",file,id,"archive","合成.qbank","application/octet-stream",bytes.length,sha);return null;});return new Fixture(id,file,bytes,content);
    }
    HttpResponse<byte[]> call(String path,String method,Object body,String cookie,String origin)throws Exception{
        var builder=HttpRequest.newBuilder(URI.create(origin()+path)).timeout(Duration.ofSeconds(20)).header("X-Real-IP",ip);
        if(origin!=null)builder.header("Origin",origin);if(cookie!=null)builder.header("Cookie",cookie);if(body!=null)builder.header("Content-Type","application/json");builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofByteArray(encode(body)));return client.send(builder.build(),HttpResponse.BodyHandlers.ofByteArray());
    }
    HttpResponse<byte[]> get(String path,String cookie)throws Exception{return call(path,"GET",null,cookie,origin());}
    HttpResponse<byte[]> post(String path,Object value,String cookie)throws Exception{return call(path,"POST",value,cookie,origin());}
    @SuppressWarnings("unchecked") Map<String,Object> object(HttpResponse<byte[]> reply){return JSON.readValue(reply.body(),Map.class);}
    @SuppressWarnings("unchecked") List<Map<String,Object>> banks(Fixture fixture,String cookie)throws Exception{var response=get("/api/packs/"+fixture.id+"/catalog",cookie);assertEquals(200,response.statusCode(),new String(response.body(),StandardCharsets.UTF_8));return (List<Map<String,Object>>)object(response).get("banks");}
    Map<String,Object> selection(Fixture fixture,List<?> ids){return Map.of("revision",1,"sha256",HexFormat.of().formatHex(AccountCrypto.sha(fixture.bytes)),"banks",ids);}
    Map<String,byte[]> unzip(byte[] bytes)throws IOException{var result=new HashMap<String,byte[]>();try(var zip=new ZipInputStream(new ByteArrayInputStream(bytes))){for(ZipEntry entry;(entry=zip.getNextEntry())!=null;)if(!entry.isDirectory())result.put(entry.getName(),zip.readAllBytes());}return result;}
    long downloads(Fixture fixture){return db.read(c->number(row(c,"SELECT downloads FROM packs WHERE id=?",fixture.id).get("downloads")));}
    void noWorkFiles()throws Exception{for(int attempt=0;attempt<20;attempt++){try(var paths=Files.walk(DIRECTORY.resolve("selection-work"))){if(paths.noneMatch(Files::isRegularFile))return;}Thread.sleep(20);}fail("Selection workspace was not cleaned");}

    @Test void catalogCountsOnlyRealBanksWithoutExecutingExtensionExamples()throws Exception{
        var fixture=pack(content(),"approved");var banks=banks(fixture,null);assertEquals(2,banks.size());assertEquals(List.of("题库A","题库B"),banks.stream().map(bank->bank.get("title")).toList());assertEquals(1,number(banks.getFirst().get("questionCount")));assertTrue(((String)banks.getFirst().get("id")).matches("[a-f0-9]{64}"));assertEquals(0,downloads(fixture));
    }
    @Test void singleSelectionPreservesBankResourceAndExtensionBytesWithSingleScope()throws Exception{
        var fixture=pack(content(),"approved");String key=(String)banks(fixture,null).getFirst().get("id");var response=post("/api/packs/"+fixture.id+"/download-selection",selection(fixture,List.of(key)),null);assertEquals(200,response.statusCode(),new String(response.body(),StandardCharsets.UTF_8));assertTrue(response.headers().firstValue("Content-Disposition").orElseThrow().contains("filename*=UTF-8''"));
        var entries=unzip(response.body());assertFalse(entries.keySet().stream().anyMatch(name->name.startsWith("question-banks/Group/B/")));for(var item:fixture.content.entrySet())if(item.getKey().startsWith("question-banks/Group/A/")||item.getKey().startsWith("extensions/"))assertArrayEquals(item.getValue(),entries.get(item.getKey()));
        var marker=JSON.readTree(entries.get("quizforge-package.json"));assertEquals(3,marker.get("formatVersion").asInt());assertEquals("bank",marker.get("scope").asText());assertEquals("Group",marker.get("group").asText());assertEquals(1,downloads(fixture));noWorkFiles();
    }
    @Test void multipleSelectionHasGroupScopeAndChargesActualOutputBytes()throws Exception{
        var fixture=pack(content(),"approved");var keys=banks(fixture,null).stream().map(bank->bank.get("id")).toList();String month=YearMonth.now(ZoneId.of(properties.timeZone())).toString();long before=db.read(c->{var row=row(c,"SELECT bytes FROM traffic WHERE period=?",month);return row==null?0:number(row.get("bytes"));});
        var response=post("/api/packs/"+fixture.id+"/download-selection",selection(fixture,keys),null);assertEquals(200,response.statusCode());var entries=unzip(response.body());assertTrue(entries.containsKey("question-banks/Group/B/bank.json"));assertFalse(JSON.readTree(entries.get("quizforge-package.json")).has("scope"));long after=db.read(c->number(row(c,"SELECT bytes FROM traffic WHERE period=?",month).get("bytes")));assertEquals(response.body().length,after-before);noWorkFiles();
    }
    @Test void staleRevisionCrossOriginAndInvalidSelectionsDoNotCharge()throws Exception{
        var fixture=pack(content(),"approved");String key=(String)banks(fixture,null).getFirst().get("id");String path="/api/packs/"+fixture.id+"/download-selection";var stale=new HashMap<>(selection(fixture,List.of(key)));stale.put("revision",2);assertEquals(409,post(path,stale,null).statusCode());assertEquals(403,call(path,"POST",selection(fixture,List.of(key)),null,"https://untrusted.example").statusCode());
        for(var ids:List.of(List.of(),List.of(key,key),List.of("a".repeat(64))))assertEquals(400,post(path,selection(fixture,ids),null).statusCode());assertEquals(0,downloads(fixture));
    }
    @Test void badFormatUnsafePathsDuplicatePathsAndChangedHashesFailClosed()throws Exception{
        for(int variant=0;variant<4;variant++){
            var content=content();if(variant==0)content.put("quizforge-package.json",encode(Map.of("format","quizforge-bank-group","formatVersion",2,"group","Group")));if(variant==1)content.put("question-banks/Group/A/../outside.txt",new byte[]{1});if(variant==2)content.put("QUESTION-BANKS/Group/A/bank.json",new byte[]{1});var fixture=pack(content,"approved");
            if(variant==3)db.transaction(c->{update(c,"UPDATE files SET sha256=? WHERE id=?","0".repeat(64),fixture.archiveId);return null;});assertEquals(422,get("/api/packs/"+fixture.id+"/catalog",null).statusCode());assertEquals(0,downloads(fixture));
        }
    }
    @Test void privateCatalogRetainsOwnerAdminBlockedAndAnonymousBoundaries()throws Exception{
        var fixture=pack(content(),"pending");String path="/api/packs/"+fixture.id+"/catalog";assertEquals(404,get(path,null).statusCode());assertEquals(404,get(path,otherCookie).statusCode());assertEquals(200,get(path,ownerCookie).statusCode());assertEquals(200,get(path,adminCookie).statusCode());db.transaction(c->{update(c,"INSERT INTO user_blocks VALUES(?,?,?,?)",owner,admin,"synthetic",System.currentTimeMillis());return null;});assertEquals(404,get(path,ownerCookie).statusCode());
    }
    @Test void budgetFailureCleansTemporaryArchiveWithoutDownloadCount()throws Exception{
        var fixture=pack(content(),"approved");String key=(String)banks(fixture,null).getFirst().get("id"),month=YearMonth.now(ZoneId.of(properties.timeZone())).toString();var prior=db.read(c->row(c,"SELECT bytes FROM traffic WHERE period=?",month));
        try{db.transaction(c->{update(c,"INSERT INTO traffic VALUES(?,?) ON CONFLICT(period) DO UPDATE SET bytes=excluded.bytes",month,properties.monthlyBudgetBytes());return null;});assertEquals(429,post("/api/packs/"+fixture.id+"/download-selection",selection(fixture,List.of(key)),null).statusCode());assertEquals(0,downloads(fixture));noWorkFiles();}
        finally{db.transaction(c->{if(prior==null)update(c,"DELETE FROM traffic WHERE period=?",month);else update(c,"UPDATE traffic SET bytes=? WHERE period=?",prior.get("bytes"),month);return null;});}
    }
    @Test void commentWritesPersistAndDeletionRequiresAuthorOrCurrentAdmin()throws Exception{
        var fixture=pack(content(),"approved");String path="/api/packs/"+fixture.id+"/comments";assertEquals(401,post(path,Map.of("body","hello"),null).statusCode());assertEquals(403,call(path,"POST",Map.of("body","hello"),ownerCookie,"https://untrusted.example").statusCode());assertEquals(400,post(path,Map.of("body"," \n\u00a0"),ownerCookie).statusCode());
        var response=post(path,Map.of("body","<img src=x onerror=alert(1)>"),ownerCookie);assertEquals(201,response.statusCode());String id=JSON.readTree(response.body()).get("comment").get("id").asText();String endpoint="/api/comments/"+id;assertEquals(403,call(endpoint,"DELETE",null,otherCookie,origin()).statusCode());assertEquals(200,call(endpoint,"DELETE",null,ownerCookie,origin()).statusCode());assertEquals(404,call(endpoint,"DELETE",null,ownerCookie,origin()).statusCode());
        response=post(path,Map.of("body","admin removal"),ownerCookie);id=JSON.readTree(response.body()).get("comment").get("id").asText();assertEquals(200,call("/api/comments/"+id,"DELETE",null,adminCookie,origin()).statusCode());
    }
    @Test void reportsRequireLoginApprovalAndBoundedReasons()throws Exception{
        var fixture=pack(content(),"approved");String path="/api/packs/"+fixture.id+"/report";assertEquals(401,post(path,Map.of("reason","reason"),null).statusCode());assertEquals(400,post(path,Map.of("reason","a".repeat(1001)),otherCookie).statusCode());assertEquals(201,post(path,Map.of("reason","合成举报原因"),otherCookie).statusCode());assertEquals(1L,(long)db.read(c->number(row(c,"SELECT COUNT(*) AS n FROM reports WHERE pack_id=?",fixture.id).get("n"))));
        var pending=pack(content(),"pending");assertEquals(409,post("/api/packs/"+pending.id+"/comments",Map.of("body","test"),ownerCookie).statusCode());assertEquals(404,post("/api/packs/"+pending.id+"/report",Map.of("reason","test"),otherCookie).statusCode());
    }
    @Test void reportRateLimitStopsAdditionalDatabaseWrites()throws Exception{
        var fixture=pack(content(),"approved");String path="/api/packs/"+fixture.id+"/report";for(int i=0;i<5;i++)assertEquals(201,post(path,Map.of("reason","synthetic "+i),otherCookie).statusCode());assertEquals(429,post(path,Map.of("reason","extra"),otherCookie).statusCode());assertEquals(5L,(long)db.read(c->number(row(c,"SELECT COUNT(*) AS n FROM reports WHERE pack_id=?",fixture.id).get("n"))));
    }
}
