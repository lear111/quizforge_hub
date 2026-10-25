package cloud.treenewbee.quizforge.hub.maintenance;

import java.math.*;
import java.util.*;
import org.springframework.stereotype.Service;
import cloud.treenewbee.quizforge.hub.account.*;
import cloud.treenewbee.quizforge.hub.admin.*;
import cloud.treenewbee.quizforge.hub.storage.HubDatabase;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;

@Service
public class HubMaintenance {
    private final HubDatabase db;private final AdminService admin;private final AuthPolicy policy;private final InstallerMaintenance installers;
    public HubMaintenance(HubDatabase db,AdminService admin,AuthPolicy policy,InstallerMaintenance installers){this.db=db;this.admin=admin;this.policy=policy;this.installers=installers;}
    public static boolean validArguments(List<String> args){
        if(args.isEmpty())return false;int n=args.size();return switch(args.getFirst()){
            case "promote","demote","invite-list","auth-login-recovery","download-remove"->n==2;
            case "invite-create"->n>=2&&n<=4;case "invite-revoke"->n==3;
            case "signup-bonus"->n==1||n==2;case "download-publish"->n==4||n==5;default->false;};
    }
    public Object execute(List<String> args){
        if(!validArguments(args))throw new IllegalArgumentException("命令或参数不完整");String action=args.getFirst();
        if(action.equals("signup-bonus")){
            if(args.size()==2){long amount;try{amount=new BigDecimal(args.get(1)).movePointRight(4).setScale(0,RoundingMode.HALF_UP).longValueExact();}catch(ArithmeticException|NumberFormatException error){throw new IllegalArgumentException("赠送额度应在 0–100 元之间");}if(amount<0||amount>1000000)throw new IllegalArgumentException("赠送额度应在 0–100 元之间");long value=amount;db.transaction(c->{update(c,"UPDATE ai_signup_bonus SET amount=? WHERE id=1",value);return null;});}
            return db.read(c->Map.of("amount",number(row(c,"SELECT amount FROM ai_signup_bonus WHERE id=1").get("amount"))));
        }
        if(action.equals("download-publish"))return installers.publish(args.get(1),args.get(2),args.get(3),args.size()==5?args.get(4):"");
        if(action.equals("download-remove"))return installers.remove(args.get(1));
        var contact=Contact.parse(Map.of("identifier",args.get(1)));var account=db.read(c->AccountStore.account(c,contact));
        if(account==null)throw new IllegalArgumentException("找不到该账号，请先在网站注册");Object id=account.get("id");
        if(action.equals("promote")||action.equals("demote")){boolean grant=action.equals("promote");db.transaction(c->{update(c,"UPDATE users SET admin=? WHERE id=?",grant?1:0,id);update(c,"INSERT INTO admin_audit VALUES(?,?,?,?,?,?)",UUID.randomUUID().toString(),id,id.toString(),"local-role-"+action,grant?"{\"admin\":true,\"source\":\"local-command\"}":"{\"admin\":false,\"source\":\"local-command\"}",System.currentTimeMillis());return null;});return Map.of("ok",true,"admin",grant);}
        db.read(c->{AdminAccess.current(c,id);return null;});
        return switch(action){
            case "invite-create"->admin.createInvitations(Map.of("count",args.size()>2?integer(args.get(2)):1,"days",args.size()>3?integer(args.get(3)):30),id);
            case "invite-list"->admin.invitations();
            case "invite-revoke"->admin.revokeInvitation(args.get(2),id);
            case "auth-login-recovery"->policy.set(Map.of("loginCodeRequired",false,"loginCaptchaRequired",false),id);
            default->throw new IllegalArgumentException("不支持的维护命令");};
    }
    private long integer(String raw){try{return Long.parseLong(raw);}catch(NumberFormatException error){throw new IllegalArgumentException("数量和天数必须为整数");}}
}
