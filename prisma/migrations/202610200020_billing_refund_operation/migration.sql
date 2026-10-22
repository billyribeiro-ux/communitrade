-- Link provider refund truth to the durable core operation that authorized it.
ALTER TABLE fake_billing_refund ADD COLUMN operation_id varchar(255);
CREATE INDEX fake_billing_refund_operation_idx ON fake_billing_refund(provider_account_id,mode,operation_id) WHERE operation_id IS NOT NULL;
