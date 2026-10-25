package cloud.treenewbee.quizforge.hub.catalog;

import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.AccountCrypto;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={"hub.local-import-enabled=true","logging.level.root=WARN"})
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class LocalImportHttpTest {
    static final Path ROOT;static{try{ROOT=Files.createTempDirectory("qfh-java-local-import-");}catch(Exception e){throw new ExceptionInInitializerError(e);}}
    static final JsonMapper JSON=JsonMapper.builder().build();
    @DynamicPropertySource static void data(DynamicPropertyRegistry registry){registry.add("hub.data-dir",ROOT::toString);}
    @Autowired HubDatabase db;@Autowired HubProperties properties;@Value("${local.server.port}") int port;
    HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();String id,file,user,cookie,sha;byte[] bytes={0x50,0x4b,3,4,1,2,3,4};
    @BeforeEach void seed()throws Exception{user=UUID.randomUUID().toString();id=UUID.randomUUID().toString();file=UUID.randomUUID().toString();String raw=AccountCrypto.token();cookie="qfh_session="+raw;sha=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));Files.write(ROOT.resolve("files").resolve(file),bytes);db.transaction(c->{String now=Instant.now().toString();update(c,"INSERT INTO users VALUES(?,?,?,?,?,?)",user,user+"@example.test","Synthetic","!disabled",1,now);update(c,"INSERT INTO sessions VALUES(?,?,?)",AccountCrypto.sha(raw),user,System.currentTimeMillis()+3600000);update(c,"INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated,status) VALUES(?,?,?,?,?,?,?,?,?,?,'approved')",id,user,"Synthetic","s","d","Other","[]","1.0",now,now);update(c,"INSERT INTO files VALUES(?,?,?,?,?,?,?)",file,id,"archive","合成.qbank","application/zip",bytes.length,sha);return null;});}
    String path(){return "/api/packs/"+id;}
    HttpResponse<byte[]> call(String path,String method,String cookie)throws Exception{var req=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+port+path));if(cookie!=null)req.header("Cookie",cookie);return client.send(req.method(method,HttpRequest.BodyPublishers.noBody()).build(),HttpResponse.BodyHandlers.ofByteArray());}
    long downloads(){return db.read(c->number(row(c,"SELECT downloads FROM packs WHERE id=?",id).get("downloads")));}
    @Test void manifestIsAnonymousReadOnlyAndPinnedDownloadPreservesBytes()throws Exception{var manifest=call(path()+"/local-import?revision=1","GET",null);assertEquals(200,manifest.statusCode());var value=JSON.readTree(manifest.body());assertEquals(1,value.get("schemaVersion").asInt());assertEquals(sha,value.get("archive").get("sha256").asText());assertEquals(0,downloads());var response=call(path()+"/download?revision=1&sha256="+sha,"GET",cookie);assertEquals(200,response.statusCode());assertArrayEquals(bytes,response.body());assertTrue(response.headers().firstValue("Content-Disposition").orElseThrow().contains("filename*=UTF-8''"));assertEquals(1,downloads());}
    @Test void pendingArchiveStaysHiddenEvenFromIncidentalOwnerCookie()throws Exception{db.transaction(c->{update(c,"UPDATE packs SET status='pending' WHERE id=?",id);return null;});for(String cookie:Arrays.asList(null,this.cookie)){assertEquals(404,call(path()+"/local-import?revision=1","GET",cookie).statusCode());assertEquals(404,call(path()+"/download?revision=1&sha256="+sha,"GET",cookie).statusCode());}assertEquals(0,downloads());}
    @Test void staleMalformedAndDuplicatePinsFailBeforeCharging()throws Exception{assertEquals(409,call(path()+"/local-import?revision=2","GET",null).statusCode());assertEquals(409,call(path()+"/download?revision=1&sha256="+"0".repeat(64),"GET",null).statusCode());for(String query:List.of("revision=0","revision=1&revision=1","revision=1&extra=1","revision=%31"))assertEquals(400,call(path()+"/local-import?"+query,"GET",null).statusCode());assertEquals(400,call(path()+"/download?revision=1","GET",null).statusCode());assertEquals(405,call(path()+"/local-import?revision=1","POST",null).statusCode());assertEquals(0,downloads());}
    @Test void budgetFailureClosesOpenedStreamAndDoesNotIncrementDownloads()throws Exception{String month=YearMonth.now(ZoneId.of(properties.timeZone())).toString();var previous=db.read(c->row(c,"SELECT bytes FROM traffic WHERE period=?",month));try{db.transaction(c->{update(c,"INSERT INTO traffic VALUES(?,?) ON CONFLICT(period) DO UPDATE SET bytes=excluded.bytes",month,properties.monthlyBudgetBytes());return null;});var response=call(path()+"/download?revision=1&sha256="+sha,"GET",null);assertEquals(429,response.statusCode());assertEquals("LOCAL_IMPORT_TRAFFIC_LIMIT",JSON.readTree(response.body()).get("code").asText());assertEquals(0,downloads());Path original=ROOT.resolve("files").resolve(file),moved=ROOT.resolve("files").resolve(file+".check");Files.move(original,moved);Files.move(moved,original);}finally{db.transaction(c->{if(previous==null)update(c,"DELETE FROM traffic WHERE period=?",month);else update(c,"UPDATE traffic SET bytes=? WHERE period=?",previous.get("bytes"),month);return null;});}}
    @AfterAll static void cleanup()throws Exception{try(var paths=Files.walk(ROOT)){for(var path:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}}
}
