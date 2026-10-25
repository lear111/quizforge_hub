package cloud.treenewbee.quizforge.hub.maintenance;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.security.*;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.config.HubProperties;

@Service
public class InstallerMaintenance {
    private final Path root;private final JsonMapper json=JsonMapper.builder().build();
    public InstallerMaintenance(HubProperties config){root=config.dataDir().resolve("downloads");}
    private String extension(String platform){return switch(platform){case "windows"->".exe";case "android"->".apk";default->throw new IllegalArgumentException("平台应为 windows 或 android");};}
    private void directory()throws IOException{if(Files.isSymbolicLink(root))throw new IOException();Files.createDirectories(root);}
    private Path named(String name)throws IOException{if(!name.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,120}")||Files.isSymbolicLink(root.resolve(name)))throw new IOException();return root.resolve(name);}
    private List<Map<String,Object>> items()throws IOException{
        Path file=root.resolve("manifest.json");if(!Files.exists(file,LinkOption.NOFOLLOW_LINKS))return new ArrayList<>();if(Files.isSymbolicLink(file)||Files.size(file)>1048576)throw new IOException();
        var value=json.readTree(Files.readString(file));if(!value.path("items").isArray())throw new IOException();
        var result=new ArrayList<Map<String,Object>>();for(var item:value.path("items")){String platform=item.path("platform").asText(""),name=item.path("file").asText("");if(!name.endsWith(extension(platform)))throw new IOException();named(name);result.add(json.convertValue(item,Map.class));}return result;
    }
    private void move(Path source,Path target)throws IOException{try{Files.move(source,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}catch(AtomicMoveNotSupportedException error){Files.move(source,target,StandardCopyOption.REPLACE_EXISTING);}}
    protected void manifest(List<Map<String,Object>> entries)throws IOException{Path temp=Files.createTempFile(root,"manifest-",".part");try{Files.writeString(temp,json.writeValueAsString(Map.of("schemaVersion",1,"items",entries))+"\n");move(temp,named("manifest.json"));}finally{Files.deleteIfExists(temp);}}
    public Object publish(String platform,String source,String version,String label){
        String suffix=extension(platform);if(!version.matches("[0-9A-Za-z.+-]{1,40}")||label.length()>20)throw new IllegalArgumentException("版本号或版本说明无效");
        try{directory();try(var lock=FileChannel.open(named("publisher.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);var held=lock.lock()){
            var entries=items();var previous=entries.stream().filter(i->platform.equals(i.get("platform"))).findFirst().orElse(null);
            String filename="QuizForge-"+version+"-"+platform+suffix;Path target=named(filename),temp=Files.createTempFile(root,"installer-",".part");
            var digest=MessageDigest.getInstance("SHA-256");long size=0;Path rollback=null;boolean installed=false,saved=false;
            Map<String,Object> item;
            try{try(var input=Files.newInputStream(Path.of(source));var output=Files.newOutputStream(temp)){byte[] buffer=new byte[65536];for(int count;(count=input.read(buffer))!=-1;){digest.update(buffer,0,count);output.write(buffer,0,count);size+=count;}}
                if(size==0)throw new IOException();
                if(Files.exists(target,LinkOption.NOFOLLOW_LINKS)){if(!Files.isRegularFile(target,LinkOption.NOFOLLOW_LINKS))throw new IOException();rollback=Files.createTempFile(root,"previous-",".rollback");Files.copy(target,rollback,StandardCopyOption.REPLACE_EXISTING);}
                move(temp,target);installed=true;
                item=new LinkedHashMap<>();item.put("platform",platform);item.put("version",version);item.put("label",label);item.put("file",filename);item.put("bytes",size);item.put("sha256",HexFormat.of().formatHex(digest.digest()));item.put("updated",Instant.now().toString());
                entries.removeIf(i->platform.equals(i.get("platform")));entries.add(item);manifest(entries);saved=true;
            }finally{
                if(installed&&!saved){if(rollback!=null){move(rollback,target);rollback=null;}else Files.deleteIfExists(target);}
                Files.deleteIfExists(temp);if(rollback!=null)Files.deleteIfExists(rollback);
            }
            if(previous!=null&&!filename.equals(previous.get("file")))Files.deleteIfExists(named(previous.get("file").toString()));return item;
        }}catch(IOException|GeneralSecurityException error){throw new IllegalArgumentException("安装包发布失败，请保留原文件并检查路径、清单和权限");}
    }
    public Object remove(String platform){extension(platform);try{directory();try(var lock=FileChannel.open(named("publisher.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);var held=lock.lock()){
        var entries=items();var previous=entries.stream().filter(i->platform.equals(i.get("platform"))).findFirst().orElse(null);if(previous==null)return Map.of("removed",false);
        entries.remove(previous);manifest(entries);Files.deleteIfExists(named(previous.get("file").toString()));return Map.of("removed",true);
    }}catch(IOException error){throw new IllegalArgumentException("安装包移除失败，请保留清单并检查权限");}}
}
