package cloud.treenewbee.quizforge.hub.catalog;

import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.*;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.common.HubException;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.delivery.FileDelivery;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.number;

/** Reads JSON metadata and copies ZIP bytes; never loads extension code or extracts an archive. */
@Service
public class PackArchiveService {
    private static final long FILE_LIMIT=8L*1024*1024, EXPANDED_LIMIT=128L*1024*1024, ARCHIVE_LIMIT=64L*1024*1024;
    private static final String MARKER="quizforge-package.json";
    private final FileDelivery files; private final HubProperties config;
    private final JsonMapper json=JsonMapper.builder().enable(tools.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build();
    private final Semaphore scans=new Semaphore(1), exports=new Semaphore(2);
    private final Map<String,Archive> cache=new LinkedHashMap<>(8,.75f,true);
    private record Bank(String id,String prefix,Map<String,Object> view) {}
    private record Archive(Path file,Map<String,Object> marker,List<Bank> banks) {}
    public PackArchiveService(FileDelivery files,HubProperties config){this.files=files;this.config=config;}
    private static HubException invalid(String message){return new HubException(422,message);}
    private static String sha(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(NoSuchAlgorithmException error){throw new IllegalStateException(error);}}
    private static String cleanName(String raw){
        if(raw==null||raw.isBlank()||raw.length()>255||raw.matches("(?s).*[\\\\:*?\"<>|\\p{Cc}].*")||raw.endsWith(" ")||raw.endsWith(".")||Set.of(".","..").contains(raw)||raw.matches("(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?"))throw invalid("题库包包含无效路径");
        return raw;
    }
    private static String checkedPath(ZipEntry entry){
        String raw=entry.getName(),name=entry.isDirectory()?raw.substring(0,raw.length()-1):raw;
        var parts=name.split("/",-1);if(parts.length>32)throw invalid("题库包路径过深");
        for(String part:parts)cleanName(part);
        if(!Set.of("question-banks","extensions").contains(parts[0])&&!(parts.length==1&&name.equals(MARKER)&&!entry.isDirectory()))throw invalid("题库包顶层结构不支持预览");
        if(!entry.isDirectory()&&(entry.getSize()<0||entry.getSize()>FILE_LIMIT))throw invalid("题库包单个文件超过8 MiB或大小无效");
        return name;
    }
    private static long copy(ZipFile zip,ZipEntry entry,OutputStream output,long total) throws IOException {
        long length=0;var crc=new CRC32();byte[] buffer=new byte[32768];
        try(var input=zip.getInputStream(entry)){for(int n;(n=input.read(buffer))!=-1;){length+=n;if(length>FILE_LIMIT||total+length>EXPANDED_LIMIT)throw invalid("题库包展开内容超过大小限制");crc.update(buffer,0,n);output.write(buffer,0,n);}}
        if(length!=entry.getSize()||crc.getValue()!=entry.getCrc())throw invalid("题库包文件校验失败");return length;
    }
    private byte[] bytes(ZipFile zip,ZipEntry entry) throws IOException {var output=new ByteArrayOutputStream();copy(zip,entry,output,0);return output.toByteArray();}
    @SuppressWarnings("unchecked") private Map<String,Object> object(byte[] value){
        Object parsed=json.readValue(value,Object.class);if(!(parsed instanceof Map<?,?> result))throw invalid("题库包JSON格式不正确");return (Map<String,Object>)result;
    }
    private Archive read(Map<String,Object> item){
        Path file=files.archivePath(item);if(number(item.get("size"))>ARCHIVE_LIMIT)throw invalid("题库包超过64 MiB，暂不支持目录预览");
        try{
            String key=item.get("id")+":"+item.get("sha256")+":"+Files.getLastModifiedTime(file).toMillis()+":"+Files.size(file);
            synchronized(cache){var existing=cache.get(key);if(existing!=null)return existing;}
            boolean acquired;try{acquired=scans.tryAcquire(10,java.util.concurrent.TimeUnit.SECONDS);}catch(InterruptedException error){Thread.currentThread().interrupt();throw new HubException(503,"目录读取已取消，请重试");}if(!acquired)throw new HubException(503,"正在读取其他题库目录，请稍后重试");
            try{
                synchronized(cache){var existing=cache.get(key);if(existing!=null)return existing;}
                var digest=MessageDigest.getInstance("SHA-256");try(var input=new DigestInputStream(Files.newInputStream(file),digest)){input.transferTo(OutputStream.nullOutputStream());}if(!HexFormat.of().formatHex(digest.digest()).equals(item.get("sha256")))throw invalid("题库文件已变更，请联系发布者重新上传");
                try(var zip=new ZipFile(file.toFile())){
                    var entries=new LinkedHashMap<String,ZipEntry>();var seen=new HashSet<String>();long expanded=0;
                    for(var iterator=zip.entries();iterator.hasMoreElements();){var entry=iterator.nextElement();String path=checkedPath(entry);if(!seen.add(path.toLowerCase(Locale.ROOT)))throw invalid("题库包包含重复路径");if(entries.size()>=10000)throw invalid("题库包文件数量超过限制");entries.put(path,entry);if(!entry.isDirectory()){expanded+=entry.getSize();if(expanded>EXPANDED_LIMIT)throw invalid("题库包展开内容超过128 MiB");}}
                    var markerEntry=entries.get(MARKER);if(markerEntry==null||markerEntry.getSize()>262144)throw invalid("题库包缺少有效的格式标识");
                    var marker=object(bytes(zip,markerEntry));if(!"quizforge-bank-group".equals(marker.get("format"))||!(marker.get("formatVersion") instanceof Number version)||version.doubleValue()!=3)throw invalid("目录与选择下载仅支持格式3的题库包");
                    String group=marker.get("group") instanceof String name?cleanName(name):null;if(group==null)throw invalid("题库包缺少分组名称");
                    if(marker.get("scope")!=null&&!Set.of("group","bank").contains(marker.get("scope")))throw invalid("题库包范围无效");
                    var banks=new ArrayList<Bank>();boolean extensionGroup=false;
                    for(var pair:entries.entrySet()){
                        String name=pair.getKey();var entry=pair.getValue();if(name.equals(MARKER))continue;
                        var parts=name.split("/");if(parts.length>=2&&!parts[1].equals(group))throw invalid("题库包必须包含配套的单个物理分组");
                        if(parts[0].equals("extensions")&&parts.length>=2)extensionGroup=true;
                        if(!entry.isDirectory()&&parts.length==4&&parts[0].equals("question-banks")&&parts[3].equals("bank.json")){
                            if(banks.size()>=256)throw invalid("题库包超过256本，暂不支持目录预览");
                            var bank=object(bytes(zip,entry));if(!(bank.get("questions") instanceof List<?> questions))throw invalid("题库缺少题目列表");
                            String title=bank.get("title") instanceof String text&&!text.isBlank()?text:parts[2];String id=sha(name.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            var view=new LinkedHashMap<String,Object>();view.put("id",id);view.put("title",title.substring(0,Math.min(500,title.length())));view.put("questionCount",questions.size());
                            if(bank.get("version") instanceof String text)view.put("version",text.substring(0,Math.min(100,text.length())));
                            banks.add(new Bank(id,String.join("/",Arrays.copyOf(parts,3))+"/",Collections.unmodifiableMap(view)));
                        }
                    }
                    if(banks.isEmpty()||!extensionGroup||"bank".equals(marker.get("scope"))&&banks.size()!=1)throw invalid("题库包目录结构不完整");
                    banks.sort(Comparator.comparing(bank->(String)bank.view.get("title")));var result=new Archive(file,marker,List.copyOf(banks));
                    synchronized(cache){cache.put(key,result);while(cache.size()>8)cache.remove(cache.keySet().iterator().next());}return result;
                }
            }finally{scans.release();}
        }catch(IOException|tools.jackson.core.JacksonException error){throw invalid("此附件暂不支持目录预览，请下载完整文件");}catch(NoSuchAlgorithmException error){throw new IllegalStateException(error);}
    }
    public Map<String,Object> catalog(Map<String,Object> item){
        var archive=read(item);return Map.of("available",true,"revision",item.get("pack_revision"),"sha256",item.get("sha256"),"banks",archive.banks.stream().map(Bank::view).toList());
    }
    public final class Prepared implements AutoCloseable {
        public final Path file;public final String name;public final long size;private final Path directory;private final AtomicBoolean closed=new AtomicBoolean();
        private Prepared(Path directory,Path file,String name,long size){this.directory=directory;this.file=file;this.name=name;this.size=size;}
        @Override public void close() throws IOException {if(closed.compareAndSet(false,true))try{Files.deleteIfExists(file);Files.deleteIfExists(directory);}finally{exports.release();}}
    }
    public Prepared selection(Map<String,Object> item,Map<String,Object> input){
        if(!(input.get("revision") instanceof Number version)||version.doubleValue()!=number(item.get("pack_revision"))||!Objects.equals(input.get("sha256"),item.get("sha256")))throw new HubException(409,"题库已更新，请刷新详情后重新选择");
        if(!(input.get("banks") instanceof List<?> raw)||raw.isEmpty()||raw.size()>256||raw.stream().anyMatch(value->!(value instanceof String name)||!name.matches("[a-f0-9]{64}")))throw new HubException(400,"请选择需要下载的题库");
        var ids=new HashSet<>(raw);if(ids.size()!=raw.size())throw new HubException(400,"选择列表包含重复题库");var archive=read(item);
        var selected=archive.banks.stream().filter(bank->ids.contains(bank.id)).toList();if(selected.size()!=ids.size())throw new HubException(400,"选择的题库不在当前包中，请刷新");
        if(!exports.tryAcquire())throw new HubException(503,"正在打包其他下载，请稍后再试");Path directory=null,file=null;boolean prepared=false;
        try{
            Path base=config.dataDir().resolve("selection-work");if(Files.isSymbolicLink(base))throw invalid("下载工作目录不可用");Files.createDirectories(base);if(!base.toRealPath().getParent().equals(config.dataDir().toRealPath()))throw invalid("下载工作目录不可用");
            directory=Files.createTempDirectory(base,"pack-");file=directory.resolve("selected.qbank");
            var marker=new LinkedHashMap<>(archive.marker);if(selected.size()==1)marker.put("scope","bank");else marker.remove("scope");
            try(var zip=new ZipFile(archive.file.toFile());var output=new ZipOutputStream(new FilterOutputStream(Files.newOutputStream(file,StandardOpenOption.CREATE_NEW)){
                long count;private void check(int length){count+=length;if(count>ARCHIVE_LIMIT)throw invalid("打包结果超过64 MiB，请减少所选题库");}
                @Override public void write(int value)throws IOException{check(1);out.write(value);}@Override public void write(byte[] bytes,int offset,int length)throws IOException{check(length);out.write(bytes,offset,length);}
            })){
                output.putNextEntry(new ZipEntry(MARKER));output.write(json.writeValueAsBytes(marker));output.closeEntry();long total=0;
                for(var iterator=zip.entries();iterator.hasMoreElements();){var entry=iterator.nextElement();String path=checkedPath(entry);if(path.equals(MARKER))continue;
                    boolean include=path.startsWith("extensions/")||path.equals("extensions")||path.equals("question-banks")||path.equals("question-banks/"+marker.get("group"))||selected.stream().anyMatch(bank->path.startsWith(bank.prefix)||path.equals(bank.prefix.substring(0,bank.prefix.length()-1)));
                    if(!include)continue;var copy=new ZipEntry(entry.getName());copy.setTime(0);output.putNextEntry(copy);if(!entry.isDirectory())total+=copy(zip,entry,output,total);output.closeEntry();
                }
            }
            String title=selected.size()==1?(String)selected.getFirst().view.get("title"):String.valueOf(marker.get("group"))+"（"+selected.size()+"本）";
            String name=title.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]","_");name=name.substring(0,Math.min(100,name.length()))+".qbank";
            var result=new Prepared(directory,file,name,Files.size(file));prepared=true;return result;
        }catch(IOException error){throw new HubException(503,"暂时无法打包，请稍后重试");}finally{if(!prepared){try{if(file!=null)Files.deleteIfExists(file);if(directory!=null)Files.deleteIfExists(directory);}catch(IOException ignored){}exports.release();}}
    }
}
