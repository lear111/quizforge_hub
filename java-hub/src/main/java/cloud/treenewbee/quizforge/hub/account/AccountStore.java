package cloud.treenewbee.quizforge.hub.account;
import java.sql.*;
import java.util.*;
import static cloud.treenewbee.quizforge.hub.storage.HubDatabase.*;
public final class AccountStore {
    private AccountStore() {}
    public static Map<String,Object> account(Connection c,Contact contact) throws SQLException {
        return contact.channel().equals("email")?row(c,"SELECT * FROM users WHERE email=?",contact.value()):row(c,"SELECT u.* FROM users u JOIN user_phones p ON p.user_id=u.id WHERE p.phone=?",contact.value());
    }
    public static boolean blocked(Connection c,Object id) throws SQLException { return row(c,"SELECT 1 FROM user_blocks WHERE user_id=?",id)!=null; }
    public static Map<String,Object> profile(Connection c,Object id) throws SQLException {
        var user=row(c,"SELECT u.id,u.name,u.email,p.phone,u.admin FROM users u LEFT JOIN user_phones p ON p.user_id=u.id WHERE u.id=?",id);
        if(user==null)return null;
        var missing=rows(c,"SELECT channel,contact FROM unverified_contacts WHERE user_id=?",id).stream().filter(item -> Objects.equals(user.get(item.get("channel")),item.get("contact"))).map(item -> item.get("channel")).toList();
        if(!missing.isEmpty())user.put("unverifiedContacts",missing);return user;
    }
    public static void verified(Connection c,Object id,Contact contact,boolean verified,long now) throws SQLException {
        if(verified)update(c,"DELETE FROM unverified_contacts WHERE user_id=? AND channel=? AND contact=?",id,contact.channel(),contact.value());
        else update(c,"INSERT INTO unverified_contacts VALUES (?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET contact=excluded.contact",id,contact.channel(),contact.value());
        if(contact.channel().equals("phone"))update(c,"UPDATE user_phones SET verified=? WHERE user_id=? AND phone=?",verified?now:0,id,contact.value());
    }
}
