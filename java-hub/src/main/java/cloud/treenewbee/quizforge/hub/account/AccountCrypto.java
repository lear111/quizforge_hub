package cloud.treenewbee.quizforge.hub.account;

import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.concurrent.Semaphore;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;
import org.springframework.stereotype.Component;
import cloud.treenewbee.quizforge.hub.common.HubException;

@Component
public class AccountCrypto {
    private static final SecureRandom RANDOM = new SecureRandom();
    // Bound the ~16 MiB scrypt working set independently of servlet concurrency.
    private final Semaphore hashing = new Semaphore(2);
    public static byte[] utf8(String value) {
        // Node replaces lone UTF-16 surrogates with U+FFFD; Java's default is '?'.
        try {var encoded=StandardCharsets.UTF_8.newEncoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPLACE).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPLACE).replaceWith(new byte[]{(byte)0xef,(byte)0xbf,(byte)0xbd}).encode(java.nio.CharBuffer.wrap(value));byte[] bytes=new byte[encoded.remaining()];encoded.get(bytes);return bytes;}
        catch(java.nio.charset.CharacterCodingException e){throw new IllegalStateException(e);}
    }
    public static byte[] random(int length) { byte[] value = new byte[length]; RANDOM.nextBytes(value); return value; }
    public static String hex(byte[] value) { return HexFormat.of().formatHex(value); }
    public static String token() { return hex(random(32)); }
    public static String urlToken() { return Base64.getUrlEncoder().withoutPadding().encodeToString(random(32)); }
    public static String code() { return String.format(Locale.ROOT, "%06d", RANDOM.nextInt(1_000_000)); }
    public static byte[] sha(byte[] value) { try { return MessageDigest.getInstance("SHA-256").digest(value); } catch (GeneralSecurityException e) { throw new IllegalStateException(e); } }
    public static String sha(String value) { return hex(sha(utf8(value))); }
    public static byte[] hmac(byte[] key, String value) {
        try { var mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key,"HmacSHA256")); return mac.doFinal(utf8(value)); }
        catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    public static String hmac(String key, String value) { return hex(hmac(utf8(key),value)); }
    public static boolean equal(String left, String right) { return left != null && right != null && MessageDigest.isEqual(utf8(left),utf8(right)); }
    public byte[] derive(String password, String salt) {
        if (!hashing.tryAcquire()) throw new HubException(503,"登录服务繁忙，请稍后再试");
        byte[] bytes = utf8(password);
        try { return SCrypt.generate(bytes,utf8(salt),16384,8,1,64); }
        finally { Arrays.fill(bytes,(byte)0); hashing.release(); }
    }
    public String password(String plain) { String salt=hex(random(16)); return salt+":"+hex(derive(plain,salt)); }
    public boolean matches(String plain, String encoded) {
        boolean valid=encoded!=null && encoded.matches("[a-f0-9]{32}:[a-f0-9]{128}");
        String[] parts=(valid?encoded:"0".repeat(32)+":"+"0".repeat(128)).split(":");
        return MessageDigest.isEqual(derive(plain,parts[0]),HexFormat.of().parseHex(parts[1])) && valid;
    }
}
