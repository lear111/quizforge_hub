package cloud.treenewbee.quizforge.hub.account;
public interface VerificationProvider {
    boolean available(String channel);
    String pepper(String channel);
    boolean captchaReady();
    String siteKey();
    boolean verify(String token,String ip,String hostname,String action);
    void send(Contact contact,String code,String nonce,String purpose);
    default boolean reviewReady(){return false;}
    default void sendReview(String email){throw new IllegalStateException("ReviewMailDisabled");}
}
