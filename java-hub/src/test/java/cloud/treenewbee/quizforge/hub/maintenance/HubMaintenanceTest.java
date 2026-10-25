package cloud.treenewbee.quizforge.hub.maintenance;

import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.*;
import org.springframework.test.annotation.DirtiesContext;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.NONE,properties={"hub.maintenance=true","logging.level.root=WARN"})
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class HubMaintenanceTest {
    static final Path ROOT;static{try{ROOT=Files.createTempDirectory("qfh-maintenance-");}catch(Exception e){throw new ExceptionInInitializerError(e);}}
    @DynamicPropertySource static void data(DynamicPropertyRegistry r){r.add("hub.data-dir",ROOT::toString);}
    @Autowired HubDatabase db;@Autowired HubMaintenance commands;
    String account(boolean admin){String id=UUID.randomUUID().toString();db.transaction(c->{update(c,"INSERT INTO users VALUES(?,?,?,?,?,?)",id,id+"@example.test","Synthetic","!disabled",admin?1:0,Instant.now().toString());return null;});return id;}
    @Test void localRoleChangesUseStableIdentityAndLeaveAudit(){String id=account(false),email=id+"@example.test";commands.execute(List.of("promote",email));assertEquals(1L,(long)db.read(c->number(row(c,"SELECT admin FROM users WHERE id=?",id).get("admin"))));commands.execute(List.of("demote",email));assertEquals(0L,(long)db.read(c->number(row(c,"SELECT admin FROM users WHERE id=?",id).get("admin"))));assertEquals(2L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM admin_audit WHERE actor_id=?",id).get("n"))));}
    @Test void invitationsRequireAnExistingAdminAndKeepDigestOnly(){String ordinary=account(false),admin=account(true);assertThrows(RuntimeException.class,()->commands.execute(List.of("invite-create",ordinary+"@example.test")));var issued=(Map<?,?>)commands.execute(List.of("invite-create",admin+"@example.test","1","7"));var item=(Map<?,?>)((List<?>)issued.get("items")).getFirst();String id=item.get("id").toString(),code=item.get("code").toString();assertTrue(code.startsWith("QF-"));assertNotEquals(code,db.read(c->row(c,"SELECT digest FROM invitations WHERE id=?",id).get("digest")));commands.execute(List.of("invite-revoke",admin+"@example.test",id));assertNotNull(db.read(c->row(c,"SELECT revoked FROM invitations WHERE id=?",id).get("revoked")));}
    @Test void loginRecoveryKeepsRegistrationRequirements(){String admin=account(true);db.transaction(c->{update(c,"UPDATE authentication_policy SET login_code=1,login_captcha=1,registration_code=1,registration_captcha=1 WHERE id=1");return null;});commands.execute(List.of("auth-login-recovery",admin+"@example.test"));var p=db.read(c->row(c,"SELECT * FROM authentication_policy WHERE id=1"));assertEquals(0L,number(p.get("login_code")));assertEquals(0L,number(p.get("login_captcha")));assertEquals(1L,number(p.get("registration_code")));assertEquals(1L,number(p.get("registration_captcha")));}
    @Test void bonusPreservesIntegerUnitsAndRejectsInvalidAmounts(){commands.execute(List.of("signup-bonus","1.2345"));assertEquals(12345L,((Number)((Map<?,?>)commands.execute(List.of("signup-bonus"))).get("amount")).longValue());for(String value:List.of("NaN","-1","101","1e9999"))assertThrows(IllegalArgumentException.class,()->commands.execute(List.of("signup-bonus",value)));assertEquals(12345L,((Number)((Map<?,?>)commands.execute(List.of("signup-bonus"))).get("amount")).longValue());assertFalse(HubMaintenance.validArguments(List.of("download-publish","windows")));}
}
