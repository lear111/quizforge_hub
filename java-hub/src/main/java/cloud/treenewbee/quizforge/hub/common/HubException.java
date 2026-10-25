package cloud.treenewbee.quizforge.hub.common;

public class HubException extends RuntimeException {
    private final int status;
    public HubException(int status, String message) { super(message); this.status = status; }
    public int status() { return status; }
}
