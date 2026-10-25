package cloud.treenewbee.quizforge.hub.account;

import java.util.*;
import cloud.treenewbee.quizforge.hub.common.HubException;

public record Contact(String channel,String value) {
    public static Contact parse(Map<String,Object> input) {
        var keys=List.of("identifier","email","phone").stream().filter(input::containsKey).toList();
        if(keys.size()!=1 || !(input.get(keys.getFirst()) instanceof String raw)) throw new HubException(400,"请填写邮箱或中国大陆手机号，二选一即可");
        String key=keys.getFirst(), value=raw.replaceAll("^[\\s\\p{Z}\\uFEFF]+|[\\s\\p{Z}\\uFEFF]+$","");
        if(!key.equals("phone") && value.length()<=180 && value.matches("[^\\s\\p{Z}\\uFEFF@]+@[^\\s\\p{Z}\\uFEFF@]+\\.[^\\s\\p{Z}\\uFEFF@]+")) return new Contact("email",value.toLowerCase(Locale.ROOT));
        if(!key.equals("email") && value.length()<=32) {
            String phone=value.replace(" ","").replace("-","").replaceFirst("^(?:\\+86|86)(?=1\\d{10}$)","");
            if(phone.matches("1[3-9][0-9]{9}")) return new Contact("phone","+86"+phone);
        }
        throw new HubException(400,"请填写邮箱或中国大陆手机号，二选一即可");
    }
}
