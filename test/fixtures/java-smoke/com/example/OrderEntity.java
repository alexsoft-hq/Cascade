package com.example;

// A JPA entity plus a Spring Data repository — the M10 record kinds, in the
// smallest form that still exercises them: a declared @Table, a declared
// @Column, an inherited @MappedSuperclass attribute, an association, a derived
// query and a @Query. The smoke check and the fact-shard round-trip both read
// this file, so `entity`/`repository` records stay covered end to end.
@MappedSuperclass
class AuditedEntity {
    @Id
    private Long id;
}

@Entity
@Table(name = "orders")
public class OrderEntity extends AuditedEntity {

    @Column(name = "order_no")
    private String orderNo;

    private String status;

    @ManyToOne
    @JoinColumn(name = "customer_id")
    private CustomerEntity customer;
}

interface OrderEntityRepository extends JpaRepository<OrderEntity, Long> {
    OrderEntity findByOrderNo(String orderNo);

    @Query("SELECT o.status FROM OrderEntity o WHERE o.orderNo = :no")
    String statusOf(String no);
}
