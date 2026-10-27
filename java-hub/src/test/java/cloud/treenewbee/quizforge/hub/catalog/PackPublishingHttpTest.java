package cloud.treenewbee.quizforge.hub.catalog;

import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.zip.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import cloud.treenewbee.quizforge.hub.admin.PracticeAdminClient;
import cloud.treenewbee.quizforge.hub.common.HubException;
import java.util.concurrent.atomic.AtomicReference;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.account.AccountCrypto;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={"USER_QUOTA_MB=1","TOTAL_QUOTA_MB=2","logging.level.root=WARN"})
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class PackPublishingHttpTest {
    static final Path DIRECTORY;
    static{try{DIRECTORY=Files.createTempDirectory("qfh-java-publishing-");}catch(IOException error){throw new ExceptionInInitializerError(error);}}
    static final JsonMapper JSON=JsonMapper.builder().build();
    @DynamicPropertySource static void data(DynamicPropertyRegistry registry){registry.add("hub.data-dir",DIRECTORY::toString);}
    @Autowired HubDatabase db;@Autowired HubProperties properties;@Value("${local.server.port}") int port;
    @MockitoBean PracticeAdminClient bridge;
    final HttpClient client=HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();
    String owner,other,admin,cookie,otherCookie,adminCookie;
    record FilePart(String field,String name,byte[] value){}
    @BeforeEach void seed(){reset(bridge);owner=account(false);other=account(false);admin=account(true);cookie=cookie(owner);otherCookie=cookie(other);adminCookie=cookie(admin);}
    String account(boolean admin){String id=UUID.randomUUID().toString();db.transaction(c->{update(c,"INSERT INTO users VALUES(?,?,?,?,?,?)",id,id+"@example.test","合成账号","!not-a-password",admin?1:0,Instant.now().toString());return null;});return id;}
    String cookie(String user){String raw=AccountCrypto.token();db.transaction(c->{update(c,"INSERT INTO sessions VALUES(?,?,?)",AccountCrypto.sha(raw),user,System.currentTimeMillis()+3600000);return null;});return properties.cookieName()+"="+raw;}
    Map<String,String> fields(){var values=new LinkedHashMap<String,String>();values.put("title","合成题库 <tag>");values.put("summary","合成简介");values.put("description","第一行\n第二行");values.put("version","1.0");values.put("tags","测试,Java");values.put("rights","yes");return values;}
    byte[] zip()throws IOException{var out=new ByteArrayOutputStream();try(var zip=new ZipOutputStream(out)){var entry=new ZipEntry("quizforge-package.json");entry.setTime(0);zip.putNextEntry(entry);zip.write("{\"formatVersion\":3}".getBytes(StandardCharsets.UTF_8));zip.closeEntry();}return out.toByteArray();}
    FilePart archive()throws IOException{return new FilePart("archive","合成.qbank",zip());}
    FilePart image(String name){return new FilePart("screenshots",name,HexFormat.of().parseHex("89504e470d0a1a0a000000000000"));}
    HttpResponse<byte[]> upload(String id,Map<String,String> fields,List<FilePart> files,String cookie,String origin)throws Exception{
        String boundary="Qfh"+UUID.randomUUID();var out=new ByteArrayOutputStream();
        for(var field:fields.entrySet()){out.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\""+field.getKey()+"\"\r\n\r\n"+field.getValue()+"\r\n").getBytes(StandardCharsets.UTF_8));}
        for(var file:files){out.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\""+file.field+"\"; filename=\""+file.name+"\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));out.write(file.value);out.write("\r\n".getBytes(StandardCharsets.US_ASCII));}out.write(("--"+boundary+"--\r\n").getBytes(StandardCharsets.US_ASCII));
        var request=HttpRequest.newBuilder(URI.create(base()+"/api/packs"+(id==null?"":"/"+id))).header("Content-Type","multipart/form-data; boundary="+boundary).header("Origin",origin).method(id==null?"POST":"PUT",HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()));if(cookie!=null)request.header("Cookie",cookie);return client.send(request.build(),HttpResponse.BodyHandlers.ofByteArray());
    }
    String base(){return "http://127.0.0.1:"+port;}
    Map<String,Object> pack(HttpResponse<byte[]> response){assertTrue(response.statusCode()==200||response.statusCode()==201,"HTTP "+response.statusCode()+" "+new String(response.body(),StandardCharsets.UTF_8));return JSON.readValue(response.body(),Map.class).get("pack") instanceof Map<?,?> value?(Map<String,Object>)value:Map.of();}
    HttpResponse<byte[]> get(String path,String cookie)throws Exception{var request=HttpRequest.newBuilder(URI.create(base()+path));if(cookie!=null)request.header("Cookie",cookie);return client.send(request.build(),HttpResponse.BodyHandlers.ofByteArray());}
    long fileCount()throws IOException{try(var files=Files.list(DIRECTORY.resolve("files"))){return files.count();}}
    long queue(){return db.read(c->number(row(c,"SELECT generation FROM review_mail_state WHERE id=1").get("generation")));}
    void reviewBridge(String status){
        String submission=UUID.randomUUID().toString(),digest="a".repeat(64);
        var item=new AtomicReference<Map<String,Object>>(Map.of("id",submission,"status","pending","extensions",List.of(Map.of("digest",digest,"status",status,"name","合成拓展","files",List.of()))));
        when(bridge.call(eq("/submissions"),eq("POST"),isNull(),any(Path.class),anyString(),anyMap(),anyString())).thenAnswer(i->Map.of("item",item.get()));
        when(bridge.call(eq("/submissions/"+submission),anyString())).thenAnswer(i->Map.of("item",item.get()));
        when(bridge.send(eq("/submissions/"+submission+"/decision"),anyMap(),anyString())).thenAnswer(i->{item.set(Map.of("id",submission,"status","approved","extensions",List.of(Map.of("digest",digest,"status","approved"))));return Map.of("item",item.get());});
    }
    HttpResponse<byte[]> publish(String id,int revision,boolean reviewed,String cookie)throws Exception{
        var request=HttpRequest.newBuilder(URI.create(base()+"/api/packs/"+id+"/publish")).header("Origin",base()).header("Cookie",cookie).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(Map.of("revision",revision,"codeReviewed",reviewed)))).build();return client.send(request,HttpResponse.BodyHandlers.ofByteArray());
    }
    @Test void administratorUploadsAndEditsPublishKnownExtensionsWithoutReviewNotifications()throws Exception{
        reviewBridge("approved");long queued=queue();var created=upload(null,fields(),List.of(archive()),adminCookie,base());var p=pack(created);String id=p.get("id").toString();
        assertEquals("approved",p.get("status"));assertEquals(admin,p.get("reviewed_by"));assertEquals(queued,queue());assertEquals(200,get("/api/packs/"+id,null).statusCode());
        assertEquals("approved",db.read(c->row(c,"SELECT status FROM pack_cloud_approvals WHERE pack_id=?",id).get("status")));
        var input=fields();input.put("revision","1");input.put("title","管理员更新");assertEquals("approved",pack(upload(id,input,List.of(),adminCookie,base())).get("status"));assertEquals(queued,queue());
    }
    @Test void administratorConfirmsUnknownCodeInPlaceAndPublishingIsIdempotent()throws Exception{
        reviewBridge("unknown");long queued=queue();var response=upload(null,fields(),List.of(archive()),adminCookie,base());var p=pack(response);String id=p.get("id").toString();
        assertEquals("pending",p.get("status"));assertEquals("code-review-required",JSON.readTree(response.body()).path("publication").path("state").asText());assertEquals(404,get("/api/packs/"+id,null).statusCode());assertEquals(queued,queue());
        assertEquals(403,publish(id,1,true,cookie).statusCode());assertEquals(409,publish(id,2,true,adminCookie).statusCode());
        assertEquals("code-review-required",JSON.readTree(publish(id,1,false,adminCookie).body()).path("publication").path("state").asText());
        assertEquals("approved",pack(publish(id,1,true,adminCookie)).get("status"));assertEquals("approved",pack(publish(id,1,true,adminCookie)).get("status"));
        assertEquals(1L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM pack_reviews WHERE pack_id=?",id).get("n"))));assertEquals(queued,queue());
    }
    @Test void uploadCodeConfirmationDoesNotGrantOrdinaryUsersPublicationRights()throws Exception{
        var input=fields();input.put("codeReviewed","yes");long queued=queue();assertEquals("pending",pack(upload(null,input,List.of(archive()),cookie,base())).get("status"));assertEquals(queued+1,queue());verifyNoInteractions(bridge);
    }
    @Test void administratorCanConfirmCodeDuringUploadAndUnavailableBridgeKeepsSavedFiles()throws Exception{
        reviewBridge("unknown");var input=fields();input.put("codeReviewed","yes");assertEquals("approved",pack(upload(null,input,List.of(archive()),adminCookie,base())).get("status"));
        reset(bridge);when(bridge.call(eq("/submissions"),eq("POST"),isNull(),any(Path.class),anyString(),anyMap(),anyString())).thenThrow(new HubException(503,"合成审核服务不可用"));
        long queued=queue();var response=upload(null,fields(),List.of(archive()),adminCookie,base());var p=pack(response);assertEquals("pending",p.get("status"));assertEquals("not-published",JSON.readTree(response.body()).path("publication").path("state").asText());assertEquals(queued,queue());assertTrue(Files.exists(DIRECTORY.resolve("files").resolve(((Map<?,?>)p.get("archive")).get("id").toString())));
    }
    @Test void createsPendingImmutableFilesAndAnonymousCannotReadAnyPart()throws Exception{
        long queued=queue();var response=upload(null,fields(),List.of(archive(),image("截图.png")),cookie,base());assertEquals(201,response.statusCode());var pack=pack(response);String id=pack.get("id").toString();assertEquals("pending",pack.get("status"));assertEquals(1,((Number)pack.get("revision")).intValue());assertEquals(queued+1,queue());
        var archive=(Map<String,Object>)pack.get("archive");assertEquals(HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(zip())),archive.get("sha256"));assertArrayEquals(zip(),Files.readAllBytes(DIRECTORY.resolve("files").resolve(archive.get("id").toString())));
        for(String suffix:List.of("","/catalog","/download"))assertEquals(404,get("/api/packs/"+id+suffix,null).statusCode());String image=((Map<?,?>)((List<?>)pack.get("screenshots")).getFirst()).get("id").toString();assertEquals(404,get("/media/"+image,null).statusCode());assertEquals(200,get("/api/packs/"+id,cookie).statusCode());
        var mine=JSON.readTree(get("/api/packs?mine=1&status=pending",cookie).body());assertTrue(mine.get("packs").valueStream().anyMatch(p->p.get("id").asText().equals(id)));assertEquals(0,JSON.readTree(get("/api/packs?mine=1&status=approved",cookie).body()).get("count").asInt());assertFalse(JSON.readTree(get("/api/packs",null).body()).get("packs").valueStream().anyMatch(p->p.get("id").asText().equals(id)));
    }
    @Test void ownerEditsResetReviewKeepArchiveAndRejectStaleRevision()throws Exception{
        var pack=pack(upload(null,fields(),List.of(archive(),image("旧.png")),cookie,base()));String id=pack.get("id").toString();var original=(Map<?,?>)pack.get("archive");String image=((Map<?,?>)((List<?>)pack.get("screenshots")).getFirst()).get("id").toString();
        db.transaction(c->{update(c,"UPDATE packs SET status='approved',review_note='old',reviewed_by=?,reviewed_at='before' WHERE id=?",admin,id);return null;});
        var input=fields();input.put("revision","1");input.put("keepScreenshots",JSON.writeValueAsString(List.of(image)));input.put("title","改过的题库");var next=pack(upload(id,input,List.of(),cookie,base()));assertEquals("pending",next.get("status"));assertEquals(2,((Number)next.get("revision")).intValue());assertEquals("",next.get("review_note"));assertNull(next.get("reviewed_by"));assertEquals(original.get("id"),((Map<?,?>)next.get("archive")).get("id"));assertEquals(1,((List<?>)next.get("screenshots")).size());
        long files=fileCount(),queued=queue();assertEquals(409,upload(id,input,List.of(archive()),cookie,base()).statusCode());assertEquals(files,fileCount());assertEquals(queued,queue());assertEquals("改过的题库",db.read(c->row(c,"SELECT title FROM packs WHERE id=?",id).get("title")));
    }
    @Test void replacementRemovesOnlyRetiredFilesAndKeepsHistoryAndCounters()throws Exception{
        var pack=pack(upload(null,fields(),List.of(archive(),image("删除.png")),cookie,base()));String id=pack.get("id").toString(),old=((Map<?,?>)pack.get("archive")).get("id").toString(),comment=UUID.randomUUID().toString();
        db.transaction(c->{update(c,"UPDATE packs SET downloads=9 WHERE id=?",id);update(c,"INSERT INTO comments VALUES(?,?,?,?,?)",comment,id,other,"keep",Instant.now().toString());return null;});
        var input=fields();input.put("revision","1");var updated=pack(upload(id,input,List.of(new FilePart("archive","替换.zip",zip()),image("新.png")),cookie,base()));assertEquals(9,((Number)updated.get("downloads")).intValue());assertFalse(Files.exists(DIRECTORY.resolve("files").resolve(old)));assertEquals(1L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM comments WHERE id=?",comment).get("n"))));assertEquals(1,((List<?>)updated.get("screenshots")).size());
    }
    @Test void authenticationOriginOwnershipAndRightsFailWithoutWriting()throws Exception{
        long before=fileCount(),queued=queue();assertEquals(401,upload(null,fields(),List.of(archive()),null,base()).statusCode());assertEquals(403,upload(null,fields(),List.of(archive()),cookie,"https://untrusted.example").statusCode());var input=fields();input.remove("rights");assertEquals(400,upload(null,input,List.of(archive()),cookie,base()).statusCode());assertEquals(before,fileCount());assertEquals(queued,queue());
        var pack=pack(upload(null,fields(),List.of(archive()),cookie,base()));String id=pack.get("id").toString();input=fields();input.put("revision","1");assertEquals(403,upload(id,input,List.of(archive()),otherCookie,base()).statusCode());assertEquals(403,upload(id,input,List.of(archive()),adminCookie,base()).statusCode());
    }
    @Test void validatesSignaturesCountsFieldsAndScreenshots()throws Exception{
        long before=fileCount();assertEquals(400,upload(null,fields(),List.of(new FilePart("archive","fake.qbank","not zip".getBytes())),cookie,base()).statusCode());
        assertEquals(400,upload(null,fields(),List.of(archive(),new FilePart("screenshots","evil.png","<script>".getBytes())),cookie,base()).statusCode());
        assertEquals(400,upload(null,fields(),List.of(archive(),archive()),cookie,base()).statusCode());var values=fields();values.put("keepScreenshots","[\""+UUID.randomUUID()+"\"]");assertEquals(400,upload(null,values,List.of(archive()),cookie,base()).statusCode());values=fields();values.put("title","a".repeat(81));assertEquals(400,upload(null,values,List.of(archive()),cookie,base()).statusCode());
        var files=new ArrayList<FilePart>();files.add(archive());for(int i=0;i<7;i++)files.add(image(i+".png"));assertEquals(400,upload(null,fields(),files,cookie,base()).statusCode());assertEquals(before,fileCount());
    }
    @Test void quotaFailureRollsBackDatabaseQueueAndStagedFiles()throws Exception{
        long before=fileCount(),queued=queue();byte[] content=new byte[1048576+1];content[0]=0x50;content[1]=0x4b;content[2]=3;content[3]=4;
        assertEquals(400,upload(null,fields(),List.of(new FilePart("archive","large.qbank",content)),cookie,base()).statusCode());assertEquals(before,fileCount());assertEquals(queued,queue());assertEquals(0L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM packs WHERE user_id=?",owner).get("n"))));
    }
    @Test void blockedAccountCannotPublishAndRateLimitHasNoExtraWrite()throws Exception{
        db.transaction(c->{update(c,"INSERT INTO user_blocks VALUES(?,?,?,?)",owner,admin,"synthetic",System.currentTimeMillis());return null;});assertEquals(401,upload(null,fields(),List.of(archive()),cookie,base()).statusCode());
        long before=fileCount();for(int i=0;i<6;i++){var input=fields();input.remove("rights");assertEquals(400,upload(null,input,List.of(archive()),otherCookie,base()).statusCode());}assertEquals(429,upload(null,fields(),List.of(archive()),otherCookie,base()).statusCode());assertEquals(before,fileCount());
    }
    @Test void screenshotLimitAndMalformedMultipartReturnBoundedErrors()throws Exception{
        long before=fileCount();byte[] png=new byte[3*1048576+1];assertEquals(413,upload(null,fields(),List.of(archive(),new FilePart("screenshots","large.png",png)),cookie,base()).statusCode());
        var malformed=HttpRequest.newBuilder(URI.create(base()+"/api/packs")).header("Origin",base()).header("Cookie",cookie).header("Content-Type","multipart/form-data; boundary=missing").POST(HttpRequest.BodyPublishers.ofString("not a multipart body")).build();assertEquals(400,client.send(malformed,HttpResponse.BodyHandlers.ofByteArray()).statusCode());assertEquals(before,fileCount());
    }
    @Test void servletFileLimitReturns413AndSiteQuotaFailureLeavesNoObjects()throws Exception{
        long before=fileCount(),queued=queue();byte[] oversized=new byte[20*1048576+1];oversized[0]=0x50;oversized[1]=0x4b;oversized[2]=3;oversized[3]=4;
        assertEquals(413,upload(null,fields(),List.of(new FilePart("archive","oversize.qbank",oversized)),cookie,base()).statusCode());assertEquals(before,fileCount());assertEquals(queued,queue());
        var existing=pack(upload(null,fields(),List.of(archive()),otherCookie,base()));String id=existing.get("id").toString();String file=((Map<?,?>)existing.get("archive")).get("id").toString();long original=db.read(c->number(row(c,"SELECT size FROM files WHERE id=?",file).get("size")));
        try{db.transaction(c->{update(c,"UPDATE files SET size=? WHERE id=?",2*1048576,file);return null;});before=fileCount();queued=queue();assertEquals(400,upload(null,fields(),List.of(archive()),cookie,base()).statusCode());assertEquals(before,fileCount());assertEquals(queued,queue());}
        finally{db.transaction(c->{update(c,"UPDATE files SET size=? WHERE id=?",original,file);return null;});}
    }
    @Test void deletionRequiresOwnershipAndCurrentRevisionAndRemovesOnlyOwnObjects()throws Exception{
        var p=pack(upload(null,fields(),List.of(archive(),image("delete.png")),cookie,base()));String id=p.get("id").toString(),file=((Map<?,?>)p.get("archive")).get("id").toString();long before=fileCount();
        var forbidden=java.net.http.HttpRequest.newBuilder(URI.create(base()+"/api/packs/"+id)).header("Origin",base()).header("Cookie",otherCookie).DELETE().build();assertEquals(403,client.send(forbidden,HttpResponse.BodyHandlers.ofByteArray()).statusCode());
        var stale=java.net.http.HttpRequest.newBuilder(URI.create(base()+"/api/packs/"+id)).header("Origin",base()).header("Cookie",cookie).header("Content-Type","application/json").method("DELETE",HttpRequest.BodyPublishers.ofString("{\"revision\":2}")).build();assertEquals(409,client.send(stale,HttpResponse.BodyHandlers.ofByteArray()).statusCode());assertEquals(before,fileCount());
        var valid=java.net.http.HttpRequest.newBuilder(URI.create(base()+"/api/packs/"+id)).header("Origin",base()).header("Cookie",cookie).header("Content-Type","application/json").method("DELETE",HttpRequest.BodyPublishers.ofString("{\"revision\":1}")).build();assertEquals(200,client.send(valid,HttpResponse.BodyHandlers.ofByteArray()).statusCode());assertEquals(before-2,fileCount());assertFalse(Files.exists(DIRECTORY.resolve("files").resolve(file)));assertEquals(404,get("/api/packs/"+id,cookie).statusCode());assertEquals(1L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM admin_audit WHERE target=? AND action='pack-deleted'",id).get("n"))));
    }
    @AfterAll static void cleanup()throws IOException{try(var paths=Files.walk(DIRECTORY)){for(var path:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}}
}
