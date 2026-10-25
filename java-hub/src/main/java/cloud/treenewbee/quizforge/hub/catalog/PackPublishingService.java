package cloud.treenewbee.quizforge.hub.catalog;

import jakarta.servlet.http.Part;
import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.security.*;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.Semaphore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

/** Files are immutable UUID objects; only a committed submission changes their DB references. */
@Service
public class PackPublishingService {
    private static final long MIB=1048576;
    private static final Set<String> FIELDS=Set.of("title","summary","description","version","tags","rights","keepScreenshots","revision");
    private final HubDatabase db;
    private final CatalogService catalog;
    private final Path directory;
    private final long archiveLimit,userQuota,totalQuota;
    private final Semaphore slot=new Semaphore(1);
    private final JsonMapper json=JsonMapper.builder().build();
    record Upload(String id,String kind,String name,String mime,long size,String sha){}
    public PackPublishingService(HubDatabase db,CatalogService catalog,HubProperties properties,
            @Value("${MAX_ARCHIVE_MB:20}") long archiveMb,@Value("${USER_QUOTA_MB:500}") long userMb,@Value("${TOTAL_QUOTA_MB:5000}") long totalMb) {
        if(archiveMb<1||archiveMb>20||userMb<1||totalMb<1||userMb>1000000||totalMb>1000000)throw new IllegalArgumentException("Invalid publishing limits");
        this.db=db;this.catalog=catalog;directory=properties.dataDir().resolve("files");archiveLimit=archiveMb*MIB;userQuota=userMb*MIB;totalQuota=totalMb*MIB;
    }
    public void preflight(String id,String owner) { if(id!=null)db.read(c->{owned(c,id,owner);return null;}); }
    public Object delete(String id,Map<String,Object> actor,Object revision){
        var removed=db.transaction(c->{var user=row(c,"SELECT id,admin FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=users.id)",actor.get("id"));if(user==null)throw new HubException(401,"账号已失效");var pack=row(c,"SELECT * FROM packs WHERE id=?",id);if(pack==null)throw new HubException(404,"题库不存在");if(!Objects.equals(pack.get("user_id"),user.get("id"))&&number(user.get("admin"))==0)throw new HubException(403,"只能删除自己分享的题库");if(revision!=null&&(!(revision instanceof Number n)||n.doubleValue()!=n.longValue()||n.longValue()!=number(pack.get("revision"))))throw new HubException(409,"题库已更新，请重新打开详情后再删除");var files=rows(c,"SELECT id FROM files WHERE pack_id=?",id);update(c,"DELETE FROM pack_admin_reviews WHERE pack_id=?",id);update(c,"DELETE FROM pack_cloud_approvals WHERE pack_id=?",id);update(c,"DELETE FROM packs WHERE id=?",id);update(c,"INSERT INTO admin_audit VALUES(?,?,?,?,?,?)",UUID.randomUUID().toString(),user.get("id"),id,"pack-deleted",json.writeValueAsString(Map.of("revision",pack.get("revision"),"title",pack.get("title"))),System.currentTimeMillis());return files;});
        for(var file:removed){String key=file.get("id").toString();if(key.matches(CatalogService.ID))try{Files.deleteIfExists(directory.resolve(key));}catch(IOException ignored){}}
        return Map.of("ok",true);
    }
    private Map<String,Object> owned(Connection c,String id,String owner)throws SQLException {
        var pack=row(c,"SELECT * FROM packs WHERE id=?",id);
        if(pack==null)throw new HubException(404,"题库不存在");
        if(!Objects.equals(pack.get("user_id"),owner))throw new HubException(403,"只能编辑自己分享的题库");
        return pack;
    }
    public Map<String,Object> save(String packId,Map<String,Object> user,Collection<Part> parts) throws IOException {
        if(!slot.tryAcquire())throw new HubException(503,"另一个上传正在处理中，请稍后再试");
        var written=new ArrayList<Path>();boolean committed=false;
        try {
            if(parts.size()>20)throw new HubException(400,"上传项目过多");
            var fields=new HashMap<String,String>();var fileParts=new ArrayList<Part>();
            for(var part:parts){
                String name=part.getName();
                if(part.getSubmittedFileName()!=null){
                    if(!Set.of("archive","screenshots").contains(name))throw new HubException(400,"未知的上传文件字段");
                    if(part.getSize()>0)fileParts.add(part);
                }else{
                    if(!FIELDS.contains(name)||fields.containsKey(name)||part.getSize()>50000)throw new HubException(400,"表单字段无效或过长");
                    try(var in=part.getInputStream()){
                        byte[] value=in.readNBytes(50001);if(value.length>50000)throw new HubException(400,"表单字段过长");
                        try{fields.put(name,StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(value)).toString());}
                        catch(CharacterCodingException error){throw new HubException(400,"表单文字编码无效");}
                    }
                }
            }
            String title=text(fields,"title",80,true),summary=text(fields,"summary",240,true),description=text(fields,"description",12000,true);
            String version=text(fields,"version",30,false);if(version.isEmpty())version="1.0";
            if(!"yes".equals(fields.get("rights")))throw new HubException(400,"请确认有权分享题库及相关资源");
            var tags=Arrays.stream(text(fields,"tags",100,false).split("[,，]")).map(String::strip).filter(s->!s.isEmpty()).distinct().toList();
            if(tags.size()>5)throw new HubException(400,"最多添加 5 个标签");
            List<String> keep=keep(fields.getOrDefault("keepScreenshots","[]"));
            int revision=0;
            if(packId!=null)try{revision=Integer.parseInt(fields.getOrDefault("revision",""));if(revision<1)throw new NumberFormatException();}
                catch(NumberFormatException error){throw new HubException(400,"请重新打开编辑页后提交");}
            long archives=fileParts.stream().filter(p->p.getName().equals("archive")).count();
            if(archives>1||(packId==null&&archives!=1))throw new HubException(400,"请选择一个题库文件");
            if(keep.size()+fileParts.size()-archives>6)throw new HubException(400,"最多上传 6 张截图");
            if(Files.isSymbolicLink(directory)||!Files.isDirectory(directory,LinkOption.NOFOLLOW_LINKS))throw new IOException("Unavailable upload storage");
            var additions=new ArrayList<Upload>();
            for(var part:fileParts)additions.add(store(part,written));
            String id=packId==null?UUID.randomUUID().toString():packId,owner=user.get("id").toString(),finalVersion=version;
            int expectedRevision=revision;
            var removed=db.transaction(c->{
                if(row(c,"SELECT u.id FROM users u WHERE u.id=? AND NOT EXISTS(SELECT 1 FROM user_blocks b WHERE b.user_id=u.id)",owner)==null)throw new HubException(401,"账号不可用，请重新登录");
                Map<String,Object> previous=packId==null?null:owned(c,id,owner);
                if(previous!=null&&number(previous.get("revision"))!=expectedRevision)throw new HubException(409,"题库已被修改，请重新打开编辑页后再提交");
                var old=rows(c,"SELECT * FROM files WHERE pack_id=?",id);
                if(!keep.stream().allMatch(key->old.stream().anyMatch(f->f.get("id").equals(key)&&f.get("kind").equals("image"))))throw new HubException(400,"保留截图无效，请重新打开编辑页");
                if(previous!=null&&archives==0&&old.stream().noneMatch(f->f.get("kind").equals("archive")))throw new HubException(400,"请选择一个题库文件");
                var deleted=old.stream().filter(f->f.get("kind").equals("archive")?archives==1:f.get("kind").equals("image")&&!keep.contains(f.get("id"))).toList();
                long delta=additions.stream().mapToLong(Upload::size).sum()-deleted.stream().mapToLong(f->number(f.get("size"))).sum();
                long used=number(row(c,"SELECT COALESCE(SUM(f.size),0) AS n FROM files f JOIN packs p ON p.id=f.pack_id WHERE p.user_id=?",owner).get("n"));
                long total=number(row(c,"SELECT COALESCE(SUM(size),0) AS n FROM files").get("n"));
                if(used+delta>userQuota)throw new HubException(400,"已超过账号的文件存储额度");
                if(total+delta>totalQuota)throw new HubException(400,"站点文件存储空间不足，请联系管理员");
                String now=Instant.now().toString();
                if(previous==null)update(c,"INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",id,owner,title,summary,description,"其他",json.writeValueAsString(tags),finalVersion,now,now);
                else update(c,"UPDATE packs SET title=?,summary=?,description=?,tags=?,version=?,updated=?,status='pending',revision=revision+1,review_note='',reviewed_by=NULL,reviewed_at=NULL WHERE id=?",title,summary,description,json.writeValueAsString(tags),finalVersion,now,id);
                for(var f:deleted)update(c,"DELETE FROM files WHERE id=?",f.get("id"));
                for(var f:additions)update(c,"INSERT INTO files VALUES(?,?,?,?,?,?,?)",f.id,id,f.kind,f.name,f.mime,f.size,f.sha);
                // Preserve the legacy durable review queue. Delivery is a later migration module.
                update(c,"UPDATE review_mail_state SET generation=generation+1 WHERE id=1");
                return deleted;
            });
            committed=true;
            for(var file:removed){String key=String.valueOf(file.get("id"));if(key.matches(CatalogService.ID))try{Files.deleteIfExists(directory.resolve(key));}catch(IOException ignored){/* Unreferenced immutable file; do not turn a committed save into a failure. */}}
            return catalog.detail(id,user);
        } finally {
            if(!committed)for(var file:written)try{Files.deleteIfExists(file);}catch(IOException ignored){}
            slot.release();
        }
    }
    private String text(Map<String,String> fields,String name,int max,boolean required){String value=fields.getOrDefault(name,"").strip();if(value.length()>max||(required&&value.isEmpty()))throw new HubException(400,"请检查题库名称、介绍及其他文字长度");return value;}
    private List<String> keep(String value){
        try{var items=json.readTree(value);if(!items.isArray()||items.size()>6)throw new IllegalArgumentException();var result=new LinkedHashSet<String>();for(var item:items){if(!item.isString()||!item.asText().matches(CatalogService.ID)||!result.add(item.asText()))throw new IllegalArgumentException();}return List.copyOf(result);}
        catch(Exception error){throw new HubException(400,"保留截图列表无效");}
    }
    private Upload store(Part part,List<Path> written)throws IOException {
        boolean archive=part.getName().equals("archive");long max=archive?archiveLimit:3*MIB;
        if(part.getSize()>max)throw new HubException(413,archive?"题库文件不能超过 "+archiveLimit/MIB+" MB":"每张截图不能超过 3 MB");
        String name=part.getSubmittedFileName().replace('\\','/');name=name.substring(name.lastIndexOf('/')+1).strip();
        if(name.isEmpty()||name.length()>180||name.chars().anyMatch(ch->Character.isISOControl(ch)))throw new HubException(400,"文件名无效或过长");
        String lower=name.toLowerCase(Locale.ROOT),id=UUID.randomUUID().toString();Path path=directory.resolve(id);
        String mime;long size=0;MessageDigest hash;
        try{hash=MessageDigest.getInstance("SHA-256");}catch(NoSuchAlgorithmException error){throw new IllegalStateException(error);}
        try(var in=part.getInputStream();var out=Files.newOutputStream(path,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){
            written.add(path);byte[] prefix=in.readNBytes(12);mime=type(lower,prefix,archive);hash.update(prefix);out.write(prefix);size=prefix.length;
            byte[] buffer=new byte[16384];for(int count;(count=in.read(buffer))!=-1;){size+=count;if(size>max)throw new HubException(413,"上传文件过大");hash.update(buffer,0,count);out.write(buffer,0,count);}
        }
        if(size!=part.getSize())throw new HubException(400,"上传文件不完整，请重试");
        return new Upload(id,archive?"archive":"image",name,mime,size,HexFormat.of().formatHex(hash.digest()));
    }
    private String type(String name,byte[] prefix,boolean archive){
        String hex=HexFormat.of().formatHex(prefix);
        if(archive){
            if((name.endsWith(".qbank")||name.endsWith(".zip"))&&(hex.startsWith("504b0304")||hex.startsWith("504b0506")||hex.startsWith("504b0708")))return "application/zip";
            if(name.endsWith(".7z")&&hex.startsWith("377abcaf271c"))return "application/x-7z-compressed";
            if(name.endsWith(".rar")&&(hex.startsWith("526172211a0700")||hex.startsWith("526172211a070100")))return "application/vnd.rar";
        }else{
            if(name.endsWith(".png")&&hex.startsWith("89504e470d0a1a0a"))return "image/png";
            if((name.endsWith(".jpg")||name.endsWith(".jpeg"))&&hex.startsWith("ffd8ff"))return "image/jpeg";
            if(name.endsWith(".webp")&&hex.startsWith("52494646")&&prefix.length>=12&&new String(prefix,8,4,StandardCharsets.US_ASCII).equals("WEBP"))return "image/webp";
        }
        throw new HubException(400,archive?"题库文件格式无效，支持 .qbank、ZIP、7z、RAR":"截图格式无效，支持 PNG、JPEG、WebP");
    }
}
