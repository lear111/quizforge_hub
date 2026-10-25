package cloud.treenewbee.quizforge.hub.admin;

import java.net.*;
import java.net.http.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.AccountCrypto;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={"ADMIN_ENABLED=true","logging.level.root=WARN"})
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class AdminHttpTest {
    static final Path ROOT;
    static{try{ROOT=Files.createTempDirectory("qfh-java-admin-");}catch(Exception error){throw new ExceptionInInitializerError(error);}}
    static final JsonMapper JSON=JsonMapper.builder().build();
    @DynamicPropertySource static void data(DynamicPropertyRegistry registry){registry.add("hub.data-dir",ROOT::toString);}
    @Autowired HubDatabase db;@MockitoBean PracticeAdminClient bridge;@Value("${local.server.port}") int port;
    HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();String admin,owner,adminCookie,ownerCookie;
    @BeforeEach void seed(){reset(bridge);when(bridge.enabled()).thenReturn(false);admin=user(true);owner=user(false);adminCookie=cookie(admin);ownerCookie=cookie(owner);}
    String user(boolean admin){String id=UUID.randomUUID().toString();db.transaction(c->{update(c,"INSERT INTO users VALUES(?,?,?,?,?,?)",id,id+"@example.test","合成用户","!disabled",admin?1:0,Instant.now().toString());return null;});return id;}
    String cookie(String user){String token=AccountCrypto.token();db.transaction(c->{update(c,"INSERT INTO sessions VALUES(?,?,?)",AccountCrypto.sha(token),user,System.currentTimeMillis()+3600000);return null;});return "qfh_session="+token;}
    String base(){return "http://127.0.0.1:"+port;}
    HttpResponse<byte[]> call(String route,String method,Object body,String cookie)throws Exception{return call(route,method,body,cookie,base());}
    HttpResponse<byte[]> call(String route,String method,Object body,String cookie,String origin)throws Exception{var req=HttpRequest.newBuilder(URI.create(base()+route)).header("Origin",origin);if(cookie!=null)req.header("Cookie",cookie);if(body!=null)req.header("Content-Type","application/json");return client.send(req.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofByteArray());}
    Map<String,Object> value(HttpResponse<byte[]> response){assertEquals(200,response.statusCode(),new String(response.body()));return JSON.readValue(response.body(),Map.class);}
    record Pack(String id,String file,String sha){}
    Pack pack(String suffix)throws Exception{String id=UUID.randomUUID().toString(),file=UUID.randomUUID().toString();byte[] bytes={0x50,0x4b,3,4,0,1,2,3};String sha=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));Files.write(ROOT.resolve("files").resolve(file),bytes);db.transaction(c->{String now=Instant.now().toString();update(c,"INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",id,owner,"合成审核包","summary","description","其他","[]","1.0",now,now);update(c,"INSERT INTO files VALUES(?,?,?,?,?,?,?)",file,id,"archive","synthetic"+suffix,"application/zip",bytes.length,sha);return null;});return new Pack(id,file,sha);}
    @Test void adminBoundaryProtectsPagesDataAndWriteOrigin()throws Exception{
        assertEquals(303,call("/admin/","GET",null,null).statusCode());assertEquals(403,call("/admin/","GET",null,ownerCookie).statusCode());assertEquals(200,call("/admin/","GET",null,adminCookie).statusCode());for(String path:List.of("/api/admin/contact","/api/admin/users","/api/admin/packs","/api/admin/audit")){assertEquals(401,call(path,"GET",null,null).statusCode());assertEquals(403,call(path,"GET",null,ownerCookie).statusCode());}assertEquals(403,call("/api/admin/contact","PUT",Map.of("content","bad","revision",0),adminCookie,"https://untrusted.example").statusCode());
    }
    @Test void contactChangesAreOptimisticNormalizedPlainTextAndAudited()throws Exception{
        var before=value(call("/api/admin/contact","GET",null,adminCookie));String raw="  <script>plain</script>\r\nnext  ";var saved=value(call("/api/admin/contact","PUT",Map.of("content",raw,"revision",before.get("revision")),adminCookie));assertEquals("<script>plain</script>\nnext",saved.get("content"));assertEquals(saved,value(call("/api/admin-contact","GET",null,null)));assertEquals(409,call("/api/admin/contact","PUT",Map.of("content","stale","revision",before.get("revision")),adminCookie).statusCode());assertEquals(400,call("/api/admin/contact","PUT",Map.of("content","bad\u0000","revision",saved.get("revision")),adminCookie).statusCode());assertEquals(1L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM admin_audit WHERE actor_id=? AND action='admin-contact-updated'",admin).get("n"))));
    }
    @Test void invitationCodesOnlyReturnPlaintextOnceAndRevokeDoesNotDeleteUsers()throws Exception{
        var created=call("/api/admin/invitations","POST",Map.of("count",2,"days",30),adminCookie);assertEquals(201,created.statusCode());var items=JSON.readTree(created.body()).get("items");String code=items.get(0).get("code").asText(),id=items.get(0).get("id").asText();assertTrue(code.matches("QF-(?:[A-F0-9]{8}-){3}[A-F0-9]{8}"));assertEquals(AccountCrypto.sha(code),db.read(c->row(c,"SELECT digest FROM invitations WHERE id=?",id).get("digest")));String list=new String(call("/api/admin/invitations","GET",null,adminCookie).body());assertFalse(list.contains(code));assertEquals(200,call("/api/admin/invitations/"+id+"/revoke","POST",Map.of(),adminCookie).statusCode());assertNotNull(db.read(c->row(c,"SELECT revoked FROM invitations WHERE id=?",id).get("revoked")));assertEquals(400,call("/api/admin/invitations","POST",Map.of("count",101),adminCookie).statusCode());
    }
    @Test void blockingRevokesExistingWebAndDeviceCredentialsAndSelfBlockFails()throws Exception{
        String token=AccountCrypto.token();db.transaction(c->{update(c,"INSERT INTO connect_devices VALUES(?,?,?,?,?,?,?,0)",UUID.randomUUID().toString(),owner,AccountCrypto.sha(token),"Synthetic","web",Instant.now().toString(),System.currentTimeMillis());return null;});assertEquals(400,call("/api/admin/users/"+admin+"/block","PUT",Map.of("blocked",true,"reason","test"),adminCookie).statusCode());assertEquals(200,call("/api/admin/users/"+owner+"/block","PUT",Map.of("blocked",true,"reason","test"),adminCookie).statusCode());assertTrue(JSON.readTree(call("/api/me","GET",null,ownerCookie).body()).get("user").isNull());assertEquals(1L,(long)db.read(c->number(row(c,"SELECT revoked FROM connect_devices WHERE user_id=?",owner).get("revoked"))));assertEquals(404,call("/api/admin/users/"+owner+"/profile","GET",null,adminCookie).statusCode());assertEquals(200,call("/api/admin/users/"+owner+"/block","PUT",Map.of("blocked",false,"reason","test"),adminCookie).statusCode());assertEquals(200,call("/api/admin/users/"+owner+"/profile","GET",null,adminCookie).statusCode());
    }
    @Test void activityAndOverviewUseRealCountsAndInternalEndpointRejectsPublicHost()throws Exception{
        assertEquals(200,call("/api/activity","POST",Map.of("kind","practice"),ownerCookie).statusCode());var overview=value(call("/api/admin/overview?days=7","GET",null,adminCookie));assertEquals(7,((List<?>)overview.get("trend")).size());assertTrue(((Number)((Map<?,?>)overview.get("today")).get("practice")).longValue()>0);assertNull(overview.get("cloud"));assertEquals(400,call("/api/activity","POST",Map.of("kind","unknown"),ownerCookie).statusCode());
        var request=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/internal/activity")).header("Origin",base()).header("Cookie",ownerCookie).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString("{\"kind\":\"visit\"}")).build();assertEquals(403,client.send(request,HttpResponse.BodyHandlers.ofByteArray()).statusCode());
    }
    @Test void qbankNeedsImmutableInspectionAndExplicitCodeReviewBeforeApproval()throws Exception{
        var p=pack(".qbank");String path="/api/admin/packs/"+p.id;var decision=Map.of("decision","approved","reason","synthetic","revision",1,"codeReviewed",true);assertEquals(409,call(path+"/decision","POST",decision,adminCookie).statusCode());
        String submission=UUID.randomUUID().toString(),digest="a".repeat(64);var job=new AtomicReference<Map<String,Object>>(Map.of("id",submission,"status","pending","extensions",List.of(Map.of("digest",digest,"status","unknown"))));
        when(bridge.call(eq("/submissions"),eq("POST"),isNull(),any(Path.class),anyString(),anyMap(),anyString())).thenAnswer(i->Map.of("item",job.get()));when(bridge.call(eq("/submissions/"+submission),anyString())).thenAnswer(i->Map.of("item",job.get()));when(bridge.send(eq("/submissions/"+submission+"/decision"),anyMap(),anyString())).thenAnswer(i->{job.set(Map.of("id",submission,"status","approved","extensions",List.of(Map.of("digest",digest,"status","approved"))));return Map.of("item",job.get());});
        assertEquals(200,call(path+"/inspect","POST",Map.of(),adminCookie).statusCode());assertEquals(400,call(path+"/decision","POST",Map.of("decision","approved","reason","synthetic","revision",1),adminCookie).statusCode());assertEquals(200,call(path+"/decision","POST",decision,adminCookie).statusCode());assertEquals("approved",db.read(c->row(c,"SELECT status FROM packs WHERE id=?",p.id).get("status")));assertEquals("approved",db.read(c->row(c,"SELECT status FROM pack_cloud_approvals WHERE pack_id=?",p.id).get("status")));assertEquals(1L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM pack_reviews WHERE pack_id=?",p.id).get("n"))));assertEquals(200,call(path+"/unpublish","POST",Map.of("reason","synthetic withdrawal"),adminCookie).statusCode());assertEquals(404,call("/api/packs/"+p.id,"GET",null,null).statusCode());assertEquals("revoked",db.read(c->row(c,"SELECT status FROM pack_cloud_approvals WHERE pack_id=?",p.id).get("status")));
    }
    @Test void changedRevisionOrHashCannotBeApprovedAndSimpleArchiveIsDownloadOnly()throws Exception{
        var p=pack(".qbank");String path="/api/admin/packs/"+p.id;assertEquals(409,call(path+"/decision","POST",Map.of("decision","approved","reason","test","revision",2,"codeReviewed",true),adminCookie).statusCode());Files.write(ROOT.resolve("files").resolve(p.file),new byte[]{1,2,3,4,5,6,7,8});assertEquals(409,call(path+"/inspect","POST",Map.of(),adminCookie).statusCode());
        var zip=pack(".zip");assertEquals(200,call("/api/admin/packs/"+zip.id+"/decision","POST",Map.of("decision","approved","reason","manual download only","revision",1),adminCookie).statusCode());assertNull(db.read(c->row(c,"SELECT * FROM pack_cloud_approvals WHERE pack_id=?",zip.id)));
    }
    @AfterAll static void cleanup()throws Exception{try(var paths=Files.walk(ROOT)){for(var path:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}}
}
