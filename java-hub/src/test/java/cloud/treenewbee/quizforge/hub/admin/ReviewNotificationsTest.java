package cloud.treenewbee.quizforge.hub.admin;

import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.*;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import cloud.treenewbee.quizforge.hub.account.VerificationProvider;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@SpringBootTest(properties={"REVIEW_EMAIL=moderator@example.test","logging.level.root=WARN"})
@DirtiesContext(classMode=DirtiesContext.ClassMode.AFTER_CLASS)
class ReviewNotificationsTest {
    static final Path ROOT;
    static{try{ROOT=Files.createTempDirectory("qfh-review-notifier-");}catch(Exception error){throw new ExceptionInInitializerError(error);}}
    @DynamicPropertySource static void data(DynamicPropertyRegistry registry){registry.add("hub.data-dir",ROOT::toString);}
    @Autowired HubDatabase db;@Autowired ReviewNotifications notifications;@MockitoBean VerificationProvider provider;@MockitoBean Clock clock;
    long now=1800000000000L;
    @BeforeEach void seed(){reset(provider,clock);when(clock.millis()).thenReturn(now);when(provider.reviewReady()).thenReturn(true);String user=UUID.randomUUID().toString();db.transaction(c->{update(c,"DELETE FROM review_mail_attempts");update(c,"UPDATE review_mail_state SET generation=1,sent_generation=0,retry_after=0,last_sent=0,last_error='' WHERE id=1");update(c,"INSERT INTO users VALUES(?,?,?,?,?,?)",user,user+"@example.test","Synthetic","!disabled",0,Instant.now().toString());update(c,"INSERT INTO packs(id,user_id,title,summary,description,category,tags,version,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",UUID.randomUUID().toString(),user,"Synthetic","Synthetic","PRIVATE UPLOADER CONTENT MUST NOT BE EMAILED","Other","[]","1","now","now");return null;});}
    @Test void successfulReminderOnlyPassesConfiguredRecipientAndKeepsNewGenerationQueued(){
        doAnswer(invocation->{db.transaction(c->{update(c,"UPDATE review_mail_state SET generation=2 WHERE id=1");return null;});return null;}).when(provider).sendReview("moderator@example.test");notifications.wake();var state=db.read(c->row(c,"SELECT * FROM review_mail_state WHERE id=1"));assertEquals(1L,number(state.get("sent_generation")));assertEquals(2L,number(state.get("generation")));assertEquals(now,number(state.get("last_sent")));verify(provider,times(1)).sendReview("moderator@example.test");notifications.wake();verify(provider,times(1)).sendReview(anyString());
    }
    @Test void failedDeliveryIsDurablyLimitedAndRetriesAfterCooldown(){
        doThrow(new IllegalStateException("synthetic failure")).when(provider).sendReview(anyString());notifications.wake();var state=db.read(c->row(c,"SELECT * FROM review_mail_state WHERE id=1"));assertEquals(0L,number(state.get("sent_generation")));assertEquals(now+1800000,number(state.get("retry_after")));assertFalse(state.get("last_error").toString().contains("synthetic"));notifications.wake();verify(provider,times(1)).sendReview(anyString());assertEquals(1L,(long)db.read(c->number(row(c,"SELECT COUNT(*) n FROM review_mail_attempts").get("n"))));
    }
    @Test void dailyCapAndUnconfiguredProviderNeverSend(){
        db.transaction(c->{for(int i=0;i<24;i++)update(c,"INSERT INTO review_mail_attempts VALUES(?)",now-i);return null;});notifications.wake();verify(provider,never()).sendReview(anyString());when(provider.reviewReady()).thenReturn(false);notifications.wake();verify(provider,never()).sendReview(anyString());assertEquals(0L,(long)db.read(c->number(row(c,"SELECT sent_generation FROM review_mail_state WHERE id=1").get("sent_generation"))));
    }
    @AfterAll static void cleanup()throws Exception{try(var paths=Files.walk(ROOT)){for(var path:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}}
}
