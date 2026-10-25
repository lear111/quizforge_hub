package cloud.treenewbee.quizforge.hub.admin;

import java.time.Clock;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

/** Durable, coalesced reminder. Uploader content is never included in the message. */
@Service
public class ReviewNotifications {
    private final HubDatabase db;private final VerificationProvider provider;private final AuthSettings settings;private final Clock clock;private final AtomicBoolean running=new AtomicBoolean();
    public ReviewNotifications(HubDatabase db,VerificationProvider provider,AuthSettings settings,Clock clock){this.db=db;this.provider=provider;this.settings=settings;this.clock=clock;}
    public boolean ready(){return provider.reviewReady()&&settings.value("REVIEW_EMAIL").matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+");}
    public Object state(){return db.read(c->{var row=row(c,"SELECT * FROM review_mail_state WHERE id=1");var value=new LinkedHashMap<String,Object>();value.put("ready",ready());value.put("queued",number(row.get("generation"))>number(row.get("sent_generation")));value.put("lastSent",number(row.get("last_sent"))==0?null:row.get("last_sent"));value.put("error",row.get("last_error"));return value;});}
    @Scheduled(initialDelay=60000,fixedDelay=60000) public void wake(){
        if(!ready()||!running.compareAndSet(false,true))return;
        try{
            Long generation=db.transaction(c->{var state=row(c,"SELECT * FROM review_mail_state WHERE id=1");long now=clock.millis(),current=number(state.get("generation"));if(current<=number(state.get("sent_generation"))||now<number(state.get("retry_after")))return null;
                if(number(row(c,"SELECT COUNT(*) n FROM packs WHERE status='pending'").get("n"))==0){update(c,"UPDATE review_mail_state SET sent_generation=generation WHERE id=1");return null;}
                update(c,"DELETE FROM review_mail_attempts WHERE created<=?",now-86400000);if(number(row(c,"SELECT COUNT(*) n FROM review_mail_attempts").get("n"))>=24)return null;
                update(c,"INSERT INTO review_mail_attempts VALUES(?)",now);update(c,"UPDATE review_mail_state SET retry_after=? WHERE id=1",now+900000);return current;
            });
            if(generation==null)return;
            try{provider.sendReview(settings.value("REVIEW_EMAIL"));db.transaction(c->{update(c,"UPDATE review_mail_state SET sent_generation=?,last_sent=?,last_error='' WHERE id=1",generation,clock.millis());return null;});}
            catch(RuntimeException error){db.transaction(c->{update(c,"UPDATE review_mail_state SET retry_after=?,last_error='发送失败，将自动重试' WHERE id=1",clock.millis()+1800000);return null;});}
        }finally{running.set(false);}
    }
}
