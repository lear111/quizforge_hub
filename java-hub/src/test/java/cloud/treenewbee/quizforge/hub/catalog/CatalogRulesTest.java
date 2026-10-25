package cloud.treenewbee.quizforge.hub.catalog;

import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static org.junit.jupiter.api.Assertions.*;

class CatalogRulesTest {
    @TempDir Path temporary;
    private HubProperties config(Path directory) { return new HubProperties(directory, "qfh_session", 1000, 1000, "Asia/Shanghai", false, false, false, "", ""); }
    @Test void existingUnmarkedNodeDataIsRefusedBeforeSchemaChanges() throws Exception {
        var file = temporary.resolve("hub.sqlite"); java.nio.file.Files.writeString(file, "existing database bytes");
        assertThrows(IllegalStateException.class, () -> new HubDatabase(config(temporary)));
        assertEquals("existing database bytes", java.nio.file.Files.readString(file));
        assertFalse(java.nio.file.Files.exists(temporary.resolve("java-hub-local.json")));
    }
    @Test void newDataCanBeReopenedWithoutReplacingItsContents() throws Exception {
        var db = new HubDatabase(config(temporary));
        db.transaction(c -> { HubDatabase.update(c, "UPDATE admin_contact SET content='test',revision=3 WHERE id=1"); return null; });
        var reopened = new HubDatabase(config(temporary));
        assertEquals("test", reopened.read(c -> HubDatabase.row(c, "SELECT content FROM admin_contact WHERE id=1").get("content")));
    }
    @Test void paginationHandlesLegacyIntegerParsingAndBounds() {
        assertEquals(1,CatalogService.page(null));assertEquals(1,CatalogService.page("bad"));assertEquals(1,CatalogService.page("-3"));
        assertEquals(3,CatalogService.page("3abc"));assertEquals(100000,CatalogService.page("999999999999999999999999999999"));
    }
    @Test void parameterizedSearchTreatsWildcardsLiterally() throws Exception {
        var db = new HubDatabase(config(temporary));
        db.transaction(c -> {
            HubDatabase.update(c,"INSERT INTO users VALUES('author',NULL,'author','!',0,'2026-10-24')");
            for (var pair : Map.of("a","100%_match","b","10000match").entrySet())
                HubDatabase.update(c,"INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated,status) VALUES(?,'author',?,'summary','description','other','[]','1','2026-10-24','2026-10-24','approved')",pair.getKey(),pair.getValue());
            return null;
        });
        var result = new CatalogService(db).list("%_", "", "1", null);
        assertEquals(1L,result.get("count"));
        assertEquals(0L,new CatalogService(db).list("' OR 1=1 --", "", "1", null).get("count"));
    }
    @Test void redirectOriginsCannotContainUserInfoPathsOrInsecureRemoteHosts() {
        for (String value : new String[]{"http://example.test", "https://user@example.test", "https://example.test/path", "https://example.test?token=1", "javascript:alert(1)"})
            assertThrows(IllegalArgumentException.class, () -> new HubProperties(temporary,"qfh_session",1000,1000,"Asia/Shanghai",false,false,false,"",value));
    }
}
