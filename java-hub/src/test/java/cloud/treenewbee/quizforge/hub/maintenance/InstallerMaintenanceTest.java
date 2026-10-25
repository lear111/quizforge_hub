package cloud.treenewbee.quizforge.hub.maintenance;

import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import static org.junit.jupiter.api.Assertions.*;

class InstallerMaintenanceTest {
    @TempDir Path root;
    InstallerMaintenance service(){return new InstallerMaintenance(new HubProperties(root,"qfh_session",1000,1000,"Asia/Shanghai",false,false,false,"",""));}
    @Test void publishingReplacesOnlyItsPlatformAndRetainsOtherInstallers()throws Exception{
        var service=service();Path exe=root.resolve("input.exe"),apk=root.resolve("input.apk");Files.writeString(exe,"synthetic windows");Files.writeString(apk,"synthetic android");
        var first=(Map<?,?>)service.publish("windows",exe.toString(),"test.1","preview");var android=(Map<?,?>)service.publish("android",apk.toString(),"test.1","");
        var next=(Map<?,?>)service.publish("windows",exe.toString(),"test.2","");assertFalse(Files.exists(root.resolve("downloads/"+first.get("file"))));assertEquals("synthetic windows",Files.readString(root.resolve("downloads/"+next.get("file"))));assertTrue(Files.exists(root.resolve("downloads/"+android.get("file"))));
        var data=JsonMapper.builder().build().readTree(Files.readString(root.resolve("downloads/manifest.json")));assertEquals(2,data.path("items").size());service.remove("windows");assertTrue(Files.exists(root.resolve("downloads/"+android.get("file"))));assertEquals(Map.of("removed",false),service.remove("windows"));
    }
    @Test void invalidInputOrMissingSourcePreservesThePublishedManifest()throws Exception{
        var service=service();Path source=root.resolve("input.exe");Files.writeString(source,"synthetic");service.publish("windows",source.toString(),"test.1","");String original=Files.readString(root.resolve("downloads/manifest.json"));
        assertThrows(IllegalArgumentException.class,()->service.publish("windows",root.resolve("missing.exe").toString(),"test.2",""));assertThrows(IllegalArgumentException.class,()->service.publish("windows",source.toString(),"../escape",""));assertEquals(original,Files.readString(root.resolve("downloads/manifest.json")));
    }
    @Test void malformedOrEscapingManifestDoesNotDeleteOutsideFiles()throws Exception{
        Path outside=root.resolve("keep.exe");Files.writeString(outside,"keep");Files.createDirectory(root.resolve("downloads"));Path manifest=root.resolve("downloads/manifest.json");Files.writeString(manifest,"{\"items\":[{\"platform\":\"windows\",\"file\":\"../keep.exe\"}]}");String original=Files.readString(manifest);assertThrows(IllegalArgumentException.class,()->service().remove("windows"));assertEquals(original,Files.readString(manifest));assertEquals("keep",Files.readString(outside));
    }
    @Test void failedManifestReplacementRestoresThePreviousSameVersionBinary()throws Exception{
        Path source=root.resolve("input.exe");Files.writeString(source,"old binary");var first=(Map<?,?>)service().publish("windows",source.toString(),"test.1","");String original=Files.readString(root.resolve("downloads/manifest.json"));Files.writeString(source,"new binary");
        var config=new HubProperties(root,"qfh_session",1000,1000,"Asia/Shanghai",false,false,false,"","");
        var failing=new InstallerMaintenance(config){@Override protected void manifest(List<Map<String,Object>> entries)throws java.io.IOException{throw new java.io.IOException("synthetic failure");}};
        assertThrows(IllegalArgumentException.class,()->failing.publish("windows",source.toString(),"test.1",""));assertEquals(original,Files.readString(root.resolve("downloads/manifest.json")));assertEquals("old binary",Files.readString(root.resolve("downloads/"+first.get("file"))));
        try(var files=Files.list(root.resolve("downloads"))){assertTrue(files.noneMatch(p->p.toString().endsWith(".part")||p.toString().endsWith(".rollback")));}
    }
}
