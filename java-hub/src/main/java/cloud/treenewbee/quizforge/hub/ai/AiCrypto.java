package cloud.treenewbee.quizforge.hub.ai;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import javax.crypto.Cipher;
import javax.crypto.spec.*;
import org.springframework.stereotype.Component;
import cloud.treenewbee.quizforge.hub.account.AuthSettings;
import cloud.treenewbee.quizforge.hub.account.DeviceException;

/** Legacy Node layout: 12 byte IV, 16 byte GCM tag, ciphertext; base64. */
@Component
public class AiCrypto {
    public static final String KEY_AAD="quizforge-official-ai-key-v1",CODE_AAD="quizforge-redeem-code-v1";
    private final byte[] master;private final SecureRandom random=new SecureRandom();
    public AiCrypto(AuthSettings settings){byte[] key=null;try{key=Base64.getDecoder().decode(settings.value("OFFICIAL_AI_MASTER_KEY").strip());}catch(IllegalArgumentException ignored){}master=key!=null&&key.length==32?key:null;}
    public boolean ready(){return master!=null;}
    public String encrypt(String plain,String aad){if(master==null)throw new DeviceException(409,"AI_ENCRYPTION_UNAVAILABLE","服务器尚未配置加密主密钥");try{byte[] iv=new byte[12];random.nextBytes(iv);var cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(master,"AES"),new GCMParameterSpec(128,iv));cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));byte[] sealed=cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8)),output=new byte[12+sealed.length];System.arraycopy(iv,0,output,0,12);System.arraycopy(sealed,sealed.length-16,output,12,16);System.arraycopy(sealed,0,output,28,sealed.length-16);return Base64.getEncoder().encodeToString(output);}catch(Exception error){throw new IllegalStateException("AIEncryptionFailed");}}
    public String decrypt(String stored,String aad){if(master==null||stored==null)return null;try{byte[] bytes=Base64.getDecoder().decode(stored);if(bytes.length<28)return null;var cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(master,"AES"),new GCMParameterSpec(128,Arrays.copyOf(bytes,12)));cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));byte[] sealed=new byte[bytes.length-12];System.arraycopy(bytes,28,sealed,0,bytes.length-28);System.arraycopy(bytes,12,sealed,bytes.length-28,16);return new String(cipher.doFinal(sealed),StandardCharsets.UTF_8);}catch(Exception error){return null;}}
}
