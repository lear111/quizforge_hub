package cloud.treenewbee.quizforge.hub.account;
public class DeviceException extends RuntimeException {
    public final int status;public final String code;
    public DeviceException(int status,String code,String message){super(message);this.status=status;this.code=code;}
}
