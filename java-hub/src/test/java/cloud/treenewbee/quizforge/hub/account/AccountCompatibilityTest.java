package cloud.treenewbee.quizforge.hub.account;

import java.nio.file.*;
import java.time.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;
import cloud.treenewbee.quizforge.hub.config.HubProperties;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static org.junit.jupiter.api.Assertions.*;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

class AccountCompatibilityTest {
    @TempDir Path directory;
    @Test void nodeScryptVectorSupportsUnicodeAndAsciiHexSalt(){
        var crypto=new AccountCrypto();String encoded="00112233445566778899aabbccddeeff:ffd680fbd6a08b70a2d52211f1267525b95d41614a8c91a7d25fb47b37df878eb2bcc7c601965831088ce295c298704337e28599b83f8685c02ed178a752c682";
        assertTrue(crypto.matches("汉字🙂-test-password",encoded));assertFalse(crypto.matches("incorrect-password",encoded));assertFalse(crypto.matches("incorrect-password","!external-auth"));
        assertTrue(crypto.matches("round-trip-password",crypto.password("round-trip-password")));
        assertEquals("efbfbd",AccountCrypto.hex(AccountCrypto.utf8("\ud800")));
    }
    @Test void emailAndSmsSigningMatchExistingNodeVectors(){
        var env=new MockEnvironment().withProperty("TENCENT_SECRET_ID","synthetic-id").withProperty("TENCENT_SECRET_KEY","synthetic-secret").withProperty("TENCENT_SES_FROM","sender@example.test").withProperty("TENCENT_SES_TEMPLATE_ID","123")
            .withProperty("ALIYUN_SMS_ACCESS_KEY_ID","synthetic-id").withProperty("ALIYUN_SMS_ACCESS_KEY_SECRET","synthetic-secret").withProperty("ALIYUN_SMS_SIGN_NAME","QuizForge").withProperty("ALIYUN_SMS_TEMPLATE_CODE","template-test");
        var provider=new DefaultVerificationProvider(new AuthSettings(env),Clock.systemUTC());
        var email=provider.emailRequest("recipient@example.test","123456","login:fixture",1760000000L);
        assertEquals("8b7ec416b6837109ac03da2dd60e4b2dc865062104c6c339a6ad40d2f18e5b22",AccountCrypto.sha(email.body()));
        assertEquals("c3137eaa3e84362f0684bf24b4706f4168efd8cf17ff3540c98982ee60dc57d4",AccountCrypto.sha(email.headers().get("Authorization")));
        var sms=provider.smsRequest("+8613800138000","123456","out-test",Instant.parse("2026-01-02T03:04:05Z"),"nonce-test");
        assertEquals("f0e507165ac3e4aa9b49084ec8164be2bfc968f96a1b52b771a8f2d80fcce7d7",AccountCrypto.sha(sms.uri().toString()));
        assertEquals("041d91f8945fc47846482b84316c1e3bd3dae7a78155e7db5130f1e78c91f0d8",AccountCrypto.sha(sms.headers().get("Authorization")));
        assertFalse(provider.available("email"));assertFalse(provider.available("phone"));assertFalse(provider.captchaReady());
    }
    @Test void nullableEmailMigrationRetainsReferencedIdsIndexesAndTriggers() throws Exception {
        Files.writeString(directory.resolve("java-migration-snapshot.json"),"{\"complete\":true,\"sourceStopped\":true}");
        try(var c=java.sql.DriverManager.getConnection("jdbc:sqlite:"+directory.resolve("hub.sqlite"));var s=c.createStatement()){
            s.execute("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL)");
            s.execute("CREATE INDEX saved_name_index ON users(name)");s.execute("CREATE TRIGGER keep_admin BEFORE DELETE ON users WHEN OLD.admin=1 BEGIN SELECT RAISE(ABORT,'keep'); END");
            s.execute("INSERT INTO users VALUES('old-user','old@example.test','legacy','!fixture',0,'then')");s.execute("CREATE TABLE references_old(user_id TEXT REFERENCES users(id))");s.execute("INSERT INTO references_old VALUES('old-user')");
        }
        var db=new HubDatabase(new HubProperties(directory,"qfh_session",1000,1000,"Asia/Shanghai",false,false,false,"",""));
        db.transaction(c -> {update(c,"INSERT INTO users VALUES('phone-user',NULL,'phone','!fixture',0,'now')");assertNotNull(row(c,"SELECT * FROM users WHERE id='old-user'"));assertNotNull(row(c,"SELECT * FROM sqlite_master WHERE name='saved_name_index'"));assertNotNull(row(c,"SELECT * FROM sqlite_master WHERE name='keep_admin'"));assertTrue(rows(c,"PRAGMA foreign_key_check").isEmpty());return null;});
    }
    @Test void contactParsingAndDeviceRedirectsRejectAmbiguousOrRemoteInputs(){
        assertEquals("+8613800138000",Contact.parse(java.util.Map.of("identifier","86 13800138000")).value());
        assertEquals("user@example.test",Contact.parse(java.util.Map.of("email"," User@Example.Test ")).value());
        assertEquals("user@example.test",Contact.parse(java.util.Map.of("email","\u00a0User@Example.Test\ufeff")).value());
        assertThrows(RuntimeException.class,()->Contact.parse(java.util.Map.of("email","user@example.test","phone","13800138000")));
        for(String uri:new String[]{"http://127.0.0.1:80/hub/connect/callback","http://192.168.1.2:8787/hub/connect/callback","http://localhost:8787/hub/connect/callback?extra=1","https://localhost:8787/hub/connect/callback"})assertFalse(DeviceService.redirectAllowed("web",uri));
        assertTrue(DeviceService.redirectAllowed("android","quizforge://hub/connect"));assertTrue(DeviceService.redirectAllowed("web","http://127.0.0.1:8787/hub/connect/callback"));assertFalse(DeviceService.redirectAllowed(null,null));
    }
}
